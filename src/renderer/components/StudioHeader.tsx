import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Minus, Square, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';

interface MenuAction {
  label: string;
  run?: () => void;
  shortcut?: string;
  disabled?: boolean;
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
        { label: 'welcome.selectMarker', run: openProjectMarker, disabled: !!busy },
        { label: 'project.openFolder', run: openProject, disabled: !!busy },
        { label: 'action.save', run: save, shortcut: 'shortcut.ctrlS', disabled: unavailable },
        separator,
        { label: 'menu.preferences', run: () => setView('settings'), disabled: !workspaceOpen },
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
        { label: 'workspace.layout', run: () => setView('layout'), disabled: !workspaceOpen },
        { label: 'workspace.ai', run: () => setView('ai') },
        separator,
        { label: 'workspace.settings', run: () => setView('settings'), disabled: !workspaceOpen },
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
        { label: 'action.build', run: build, shortcut: 'shortcut.build', disabled: unavailable },
        { label: 'action.flash', run: flash, disabled: unavailable },
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
      if (event.key === 'Escape') setOpened(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const navigateItems = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
    ];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

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
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setOpened(menu.id);
                  requestAnimationFrame(() =>
                    menuRoot.current
                      ?.querySelector<HTMLButtonElement>(
                        `[id="${menuId}-${menu.id}"] [role="menuitem"]:not(:disabled)`,
                      )
                      ?.focus(),
                  );
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
              <div
                className="ide-menu-popup"
                id={`${menuId}-${menu.id}`}
                role="menu"
                aria-label={t(menu.label)}
                onKeyDown={navigateItems}
              >
                {menu.items.map((item, itemIndex) =>
                  item.separator ? (
                    <div className="ide-menu-separator" role="separator" key={itemIndex} />
                  ) : (
                    <button
                      className="ide-menu-item"
                      role="menuitem"
                      key={item.label}
                      disabled={item.disabled || !item.run}
                      onClick={() => {
                        setOpened(null);
                        item.run?.();
                      }}
                    >
                      <span>{t(item.label)}</span>
                      {item.shortcut && <kbd>{t(item.shortcut)}</kbd>}
                    </button>
                  ),
                )}
              </div>
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
