import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { getContextMenu } from '../../../extensions/menus';
import type { MenuTarget } from '../../../extensions/menus/types';

interface Props {
  x: number;
  y: number;
  target: MenuTarget;
  onCommand: (command: string) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, target, onCommand, onClose }: Props) {
  const { t } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    setPosition({
      left: Math.max(6, Math.min(x, window.innerWidth - bounds.width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - bounds.height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  // Collapse groups that became adjacent after filtering so the menu never shows
  // leading, trailing or repeated separators.
  const entries = getContextMenu('explorer')
    .filter((entry) => entry.separator || !entry.when || entry.when.includes(target))
    .filter((entry, index, all) => {
      if (!entry.separator) return true;
      if (index === 0 || index === all.length - 1) return false;
      return !all[index - 1]?.separator;
    });

  return createPortal(
    <div className="context-menu" style={position} ref={menu} role="menu" aria-label={t('project.title')}>
      {entries.map((entry, index) =>
        entry.separator ? (
          <div className="context-menu-separator" role="separator" key={`separator-${index}`} />
        ) : (
          <button
            key={entry.id}
            role="menuitem"
            onClick={() => {
              onCommand(entry.command);
              onClose();
            }}
          >
            <span>{t(entry.labelKey)}</span>
            {entry.shortcut && <kbd>{t(entry.shortcut)}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
