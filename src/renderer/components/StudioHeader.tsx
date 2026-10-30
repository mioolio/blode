import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Minus, Square, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { supportsLayout } from '../workspace/capabilities';
import { RELEASE_VERSION } from '../../shared/version';
import { useI18n } from '../i18n';
import { useExtensionMenus } from '../extensions/ShellAppearance';

interface MenuAction {
  label: string;
  literal?: boolean;
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
  anchor,
}: {
  id: string;
  label: string;
  items: MenuItem[];
  t: Studio['t'];
  onChoose(): void;
  onClose(): void;
  onSibling?: (direction: number) => void;
  anchor?: HTMLElement;
}) {
  const [submenu, setSubmenu] = useState<string | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const parents = useRef(new Map<string, HTMLButtonElement>());
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!anchor || !popup.current) return;
    const place = () => {
      if (!popup.current) return;
      const rect = anchor.getBoundingClientRect(),
        menu = popup.current.getBoundingClientRect();
      const left =
        rect.right + menu.width + 8 <= window.innerWidth
          ? rect.right - 2
          : Math.max(6, rect.left - menu.width + 2);
      setPosition({
        left: Math.min(left, Math.max(6, window.innerWidth - menu.width - 6)),
        top: Math.max(6, Math.min(rect.top - 5, window.innerHeight - menu.height - 6)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
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
  const content = (
    <div
      className={`ide-menu-popup${onSibling ? '' : ' ide-submenu-popup'}`}
      id={id}
      role="menu"
      aria-label={label}
      ref={popup}
      data-studio-menu="true"
      style={anchor ? { position: 'fixed', ...position } : undefined}
      onKeyDown={navigate}
    >
      {items.map((item, index) => {
        if (item.separator) return <div className="ide-menu-separator" role="separator" key={index} />;
        const childId = `${id}-submenu-${index}`;
        const expanded = submenu === item.label;
        return (
          <div
            className="ide-menu-entry"
            key={`${item.label}-${index}`}
            onPointerEnter={() => (item.children ? openSubmenu(item.label, childId) : setSubmenu(null))}
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
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (item.children) openSubmenu(item.label, childId, true);
                  else {
                    onChoose();
                    item.run?.();
                  }
                }
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
              <span>{item.literal ? item.label : t(item.label)}</span>
              {item.children ? (
                <ChevronRight size={12} aria-hidden="true" />
              ) : (
                item.shortcut && <kbd>{t(item.shortcut)}</kbd>
              )}
            </button>
            {item.children && expanded && (
              <MenuPopup
                id={childId}
                label={item.literal ? item.label : t(item.label)}
                items={item.children}
                anchor={parents.current.get(item.label)}
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
  return anchor ? createPortal(content, document.body) : content;
}

/** Standard desktop menus. Enabled items dispatch implemented workspace actions. */
export function StudioHeader({ studio }: { studio: Studio }) {
  const { locale } = useI18n();
  const extensionMenus = useExtensionMenus(locale);
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
        {
          label: 'package.title',
          run: () => window.dispatchEvent(new CustomEvent('blode:project-package')),
          disabled: unavailable,
        },
        { label: 'welcome.home', run: studio.goHome, disabled: !!busy },
        { label: 'project.close', run: studio.requestCloseProject, disabled: unavailable },
        separator,
        {
          label: 'menu.preferences',
          run: () => window.dispatchEvent(new CustomEvent('blode:preferences')),
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
        { label: 'runtime.views', run: () => window.dispatchEvent(new CustomEvent('blode:runtime-views')) },
        { label: 'workspace.code', run: () => setView('code') },
        { label: 'workspace.ai', run: () => setView('ai') },
        { label: 'ai.chat.title', run: () => window.dispatchEvent(new CustomEvent('blode:ai-open')) },
        {
          label: 'git.title',
          run: () => window.dispatchEvent(new CustomEvent('blode:git')),
          disabled: unavailable,
        },
        {
          label: studio.devicePanelVisible ? 'view.hideDevicePanel' : 'view.showDevicePanel',
          run: () => studio.setDevicePanelVisible(!studio.devicePanelVisible),
        },
        {
          label: studio.consolePanelVisible ? 'view.hideConsolePanel' : 'view.showConsolePanel',
          run: () => studio.setConsolePanelVisible(!studio.consolePanelVisible),
        },
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
      label: 'menu.generate',
      items: [
        {
          label: 'buildSettings.title',
          run: () => window.dispatchEvent(new CustomEvent('blode:build-settings')),
          disabled: unavailable,
        },
        {
          label: 'components.title',
          run: () => window.dispatchEvent(new CustomEvent('blode:component-libraries')),
          disabled: !!busy,
        },
        separator,
        {
          label: 'firmware.export',
          run: () =>
            window.dispatchEvent(new CustomEvent('blode:firmware-tools', { detail: { mode: 'export' } })),
          disabled: !!busy,
        },
        {
          label: 'firmware.flashStandalone',
          run: () =>
            window.dispatchEvent(new CustomEvent('blode:firmware-tools', { detail: { mode: 'flash' } })),
          disabled: !!busy,
        },
        separator,
        {
          label:
            !state?.build.targets?.length && studio.validatesFirmware
              ? 'action.validateFirmware'
              : 'action.build',
          run: state?.build.targets && state.build.targets.length > 1 ? undefined : () => void build(),
          children:
            state?.build.targets && state.build.targets.length > 1
              ? state.build.targets.map((target) => ({
                  label: target.name,
                  literal: true,
                  run: () => void build(target.id),
                }))
              : undefined,
          shortcut: 'shortcut.build',
          disabled:
            unavailable ||
            (!state?.build.targets?.length &&
              !studio.isAuto &&
              !studio.board?.capabilities.some(
                (capability) => capability === 'compile' || capability === 'flash',
              )),
        },
        {
          label: 'action.flash',
          run: flash,
          disabled:
            unavailable ||
            !(
              state?.buildTarget
                ? state.boards.find((board) => board.id === state.buildTarget!.config.boardId)
                : studio.board
            )?.capabilities.includes('flash'),
        },
      ],
    },
    {
      id: 'debug',
      label: 'menu.debug',
      items: [
        {
          label: 'workspace.hardwareSimulation',
          run: () => void studio.perform('workspace.hardwareSimulation', () => window.blode.openDebugger()),
        },
        {
          label: 'workspace.layout',
          run: () => setView('layout'),
          disabled: !workspaceOpen || !supportsLayout(studio.board),
        },
      ],
    },
    {
      id: 'terminal',
      label: 'menu.terminal',
      items: [
        { label: 'console.terminal', run: () => setTab('terminal') },
        { label: 'console.output', run: () => setTab('output') },
        { label: 'console.serial', run: () => setTab('serial') },
        { label: 'console.problems', run: () => setTab('problems') },
        { label: 'console.warnings', run: () => setTab('warnings') },
      ],
    },
    {
      id: 'extensions',
      label: 'menu.extensions',
      items: [
        { label: 'extensions.manage', run: () => window.dispatchEvent(new CustomEvent('blode:extensions')) },
        ...extensionMenus.items.map((item) => ({ label: item.label, literal: true, run: item.run })),
      ],
    },
    { id: 'help', label: 'menu.help', items: [{ label: 'help.automation', run: () => setView('ai') }] },
  ];

  useEffect(() => {
    const selectBuild = () => {
      setOpened('run');
      requestAnimationFrame(() => {
        const item = document
          .getElementById(`${menuId}-run`)
          ?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
        item?.click();
        requestAnimationFrame(() =>
          document.querySelector<HTMLButtonElement>('.ide-submenu-popup [role="menuitem"]')?.focus(),
        );
      });
    };
    const closeOutside = (event: PointerEvent) => {
      if (
        !menuRoot.current?.contains(event.target as Node) &&
        !(event.target as Element).closest?.('[data-studio-menu]')
      )
        setOpened(null);
    };
    window.addEventListener('blode:build-select', selectBuild);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (!event.defaultPrevented && (event.key === 'Escape' || event.key === 'Tab')) setOpened(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('blode:build-select', selectBuild);
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name" title={`Blode Studio ${RELEASE_VERSION}`}>
          Blode Studio
        </span>
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
              {extensionMenus.overrides[menu.id]?.icon && (
                <span aria-hidden="true">{extensionMenus.overrides[menu.id].icon}</span>
              )}
              {extensionMenus.overrides[menu.id]?.label ?? t(menu.label)}
            </button>
            {opened === menu.id && (
              <MenuPopup
                key={menu.id}
                id={`${menuId}-${menu.id}`}
                label={extensionMenus.overrides[menu.id]?.label ?? t(menu.label)}
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
