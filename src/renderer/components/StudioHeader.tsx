import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, Minus, Square, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { supportsLayout } from '../workspace/capabilities';

interface MenuAction {
  label: string;
  run?: () => void;
  shortcut?: string;
  disabled?: boolean;
  children?: MenuAction[];
  separator?: false;
}
interface MenuSeparator {
  separator: true;
}
type MenuItem = MenuAction | MenuSeparator;
interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

function MenuPopup({
  id,
  label,
  items,
  t,
  onChoose,
  onClose,
  onSibling,
}: {
  id: string;
  label: string;
  items: MenuItem[];
  t: Studio['t'];
  onChoose(): void;
  onClose(): void;
  onSibling?: (direction: number) => void;
}) {
  const [submenu, setSubmenu] = useState<string | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const parents = useRef(new Map<string, HTMLButtonElement>());
  const openSubmenu = (key: string, childId: string, focus = false) => {
    setSubmenu(key);
    if (focus)
      requestAnimationFrame(() =>
        document
          .getElementById(childId)
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
          ?.focus(),
      );
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const buttons = [
        ...(popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []),
      ].filter((button) => button.closest('[role="menu"]') === popup.current);
      if (!buttons.length) return;
      setSubmenu(null);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      if (submenu) {
        parents.current.get(submenu)?.focus();
        setSubmenu(null);
      } else if (event.key === 'ArrowLeft' && onSibling) onSibling(-1);
      else onClose();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      onSibling?.(1);
    }
  };
  return (
    <div
      className={`ide-menu-popup${onSibling ? '' : ' ide-submenu-popup'}`}
      id={id}
      role="menu"
      aria-label={label}
      ref={popup}
      onKeyDown={navigate}
    >
      {items.map((item, index) => {
        if (item.separator) return <div className="ide-menu-separator" role="separator" key={index} />;
        const childId = `${id}-submenu-${index}`;
        const expanded = submenu === item.label;
        return (
          <div
            className="ide-menu-entry"
            key={item.label}
            onPointerEnter={() => (item.children ? openSubmenu(item.label, childId) : setSubmenu(null))}
            onPointerLeave={() => item.children && setSubmenu(null)}
          >
            <button
              className="ide-menu-item"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled || (!item.run && !item.children)}
              aria-haspopup={item.children ? 'menu' : undefined}
              aria-expanded={item.children ? expanded : undefined}
              aria-controls={item.children ? childId : undefined}
              ref={(button) => {
                if (button) parents.current.set(item.label, button);
                else parents.current.delete(item.label);
              }}
              onKeyDown={(event) => {
                if (item.children && event.key === 'ArrowRight') {
                  event.preventDefault();
                  event.stopPropagation();
                  openSubmenu(item.label, childId, true);
                }
              }}
              onClick={(event) => {
                if (item.children) {
                  openSubmenu(item.label, childId, event.detail === 0);
                } else {
                  onChoose();
                  item.run?.();
                }
              }}
            >
              <span>{t(item.label)}</span>
              {item.children ? (
                <ChevronRight size={12} aria-hidden="true" />
              ) : (
                item.shortcut && <kbd>{t(item.shortcut)}</kbd>
              )}
            </button>
            {item.children && expanded && (
              <MenuPopup
                id={childId}
                label={t(item.label)}
                items={item.children}
                t={t}
                onChoose={onChoose}
                onClose={() => {
                  setSubmenu(null);
                  parents.current.get(item.label)?.focus();
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Standard desktop menus. Enabled items dispatch implemented workspace actions. */
export function StudioHeader({ studio }: { studio: Studio }) {
  const {
    t,
    state,
    view,
    setView,
    openProject,
    openProjectMarker,
    save,
    busy,
    build,
    flash,
    setTab,
    editorCommand,
    isWeb,
  } = studio;
  const [opened, setOpened] = useState<string | null>(null);
  const menuRoot = useRef<HTMLElement>(null);
  const menuId = useId();
  const workspaceOpen = !!state?.workspaceOpen;
  const unavailable = !!busy || !workspaceOpen;
  const noEditor = unavailable || view !== 'code' || !studio.source;
  const canFormat =
    !noEditor && ['json', 'typescript', 'javascript', 'css', 'html'].includes(studio.source?.language ?? '');
  const separator: MenuSeparator = { separator: true };
  const menus: Menu[] = [
    {
      id: 'file',
      label: 'menu.file',
      items: [
        {
          label: 'action.new',
          run: () => window.dispatchEvent(new CustomEvent('blode:new-file')),
          disabled: unavailable,
        },
        { label: 'welcome.selectFile', run: openProjectMarker, disabled: !!busy },
        { label: 'project.openFolder', run: openProject, disabled: !!busy },
        { label: 'action.save', run: save, shortcut: 'shortcut.ctrlS', disabled: unavailable },
        separator,
        {
          label: 'menu.preferences',
          children: [
            {
              label: 'settings.general',
              run: () =>
                window.dispatchEvent(
                  new CustomEvent('blode:preferences', { detail: { section: 'general' } }),
                ),
            },
            {
              label: 'settings.toolchain',
              run: () =>
                window.dispatchEvent(
                  new CustomEvent('blode:preferences', { detail: { section: 'toolchain' } }),
                ),
            },
            {
              label: 'settings.drivers',
              run: () =>
                window.dispatchEvent(
                  new CustomEvent('blode:preferences', { detail: { section: 'drivers' } }),
                ),
            },
          ],
        },
        separator,
        { label: 'menu.closeWindow', run: () => window.blode?.windowAction('close') },
      ],
    },
    {
      id: 'edit',
      label: 'menu.edit',
      items: [
        {
          label: 'edit.undo',
          run: () => editorCommand('undo'),
          shortcut: 'shortcut.undo',
          disabled: noEditor,
        },
        {
          label: 'edit.redo',
          run: () => editorCommand('redo'),
          shortcut: 'shortcut.redo',
          disabled: noEditor,
        },
        separator,
        {
          label: 'edit.find',
          run: () => editorCommand('find'),
          shortcut: 'shortcut.find',
          disabled: noEditor,
        },
        {
          label: 'edit.format',
          run: () => editorCommand('format'),
          shortcut: 'shortcut.format',
          disabled: !canFormat,
        },
      ],
    },
    {
      id: 'selection',
      label: 'menu.selection',
      items: [
        {
          label: 'selection.all',
          run: () => editorCommand('selectAll'),
          shortcut: 'shortcut.selectAll',
          disabled: noEditor,
        },
      ],
    },
    {
      id: 'view',
      label: 'menu.view',
      items: [
        { label: 'workspace.code', run: () => setView('code') },
        {
          label: 'workspace.layout',
          run: () => setView('layout'),
          disabled: !workspaceOpen || !supportsLayout(studio.board),
        },
        { label: 'workspace.ai', run: () => setView('ai') },
      ],
    },
    {
      id: 'goto',
      label: 'menu.goto',
      items: [
        {
          label: 'goto.line',
          run: () => editorCommand('gotoLine'),
          shortcut: 'shortcut.gotoLine',
          disabled: noEditor,
        },
      ],
    },
    {
      id: 'run',
      label: 'menu.run',
      items: [
        {
          label: studio.validatesFirmware ? 'action.validateFirmware' : 'action.build',
          run: build,
          shortcut: 'shortcut.build',
          disabled:
            unavailable ||
            !studio.board?.capabilities.some(
              (capability) => capability === 'compile' || capability === 'flash',
            ),
        },
        {
          label: 'action.flash',
          run: flash,
          disabled: unavailable || !studio.board?.capabilities.includes('flash'),
        },
      ],
    },
    {
      id: 'terminal',
      label: 'menu.terminal',
      items: [
        { label: 'console.output', run: () => setTab('output') },
        { label: 'console.serial', run: () => setTab('serial') },
        { label: 'console.problems', run: () => setTab('problems') },
      ],
    },
    { id: 'help', label: 'menu.help', items: [{ label: 'help.automation', run: () => setView('ai') }] },
  ];

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setOpened(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (!event.defaultPrevented && (event.key === 'Escape' || event.key === 'Tab')) setOpened(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">Blode Studio</span>
      </div>
      <nav className="menu-items ide-menubar" role="menubar" aria-label={t('menu.main')} ref={menuRoot}>
        {menus.map((menu, index) => (
          <div className="ide-menu" key={menu.id}>
            <button
              className={`ide-menu-trigger ${opened === menu.id ? 'open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={opened === menu.id}
              aria-controls={`${menuId}-${menu.id}`}
              onClick={() => setOpened((current) => (current === menu.id ? null : menu.id))}
              onPointerEnter={() => {
                if (opened) setOpened(menu.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setOpened(menu.id);
                  requestAnimationFrame(() => {
                    const buttons = document
                      .getElementById(`${menuId}-${menu.id}`)
                      ?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
                    if (buttons?.length) buttons[event.key === 'ArrowUp' ? buttons.length - 1 : 0].focus();
                  });
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  const next =
                    menus[(index + (event.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length];
                  setOpened(next.id);
                  menuRoot.current
                    ?.querySelector<HTMLButtonElement>(`[aria-controls="${menuId}-${next.id}"]`)
                    ?.focus();
                }
              }}
            >
              {t(menu.label)}
            </button>
            {opened === menu.id && (
              <MenuPopup
                key={menu.id}
                id={`${menuId}-${menu.id}`}
                label={t(menu.label)}
                items={menu.items}
                t={t}
                onChoose={() => setOpened(null)}
                onClose={() => {
                  setOpened(null);
                  menuRoot.current
                    ?.querySelector<HTMLButtonElement>(`[aria-controls="${menuId}-${menu.id}"]`)
                    ?.focus();
                }}
                onSibling={(direction) => {
                  const next = menus[(index + direction + menus.length) % menus.length];
                  setOpened(next.id);
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`${menuId}-${next.id}`)
                      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
                      ?.focus(),
                  );
                }}
              />
            )}
          </div>
        ))}
      </nav>
      <span className="topbar-spacer" aria-hidden="true" />
      {!isWeb && (
        <div className="window-controls">
          <button
            aria-label={t('window.minimize')}
            title={t('window.minimize')}
            onClick={() => window.blode?.windowAction('minimize')}
          >
            <Minus size={14} strokeWidth={2} />
          </button>
          <button
            aria-label={t('window.maximize')}
            title={t('window.maximize')}
            onClick={() => window.blode?.windowAction('maximize')}
          >
            <Square size={11} strokeWidth={2} />
          </button>
          <button
            aria-label={t('window.close')}
            title={t('window.close')}
            className="window-close"
            onClick={() => window.blode?.windowAction('close')}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
      )}
    </header>
  );
}
