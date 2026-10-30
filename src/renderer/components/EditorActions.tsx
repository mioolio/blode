import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Code2, LoaderCircle, MessageSquareText, MoreHorizontal } from 'lucide-react';
import { openAiAssistant } from '../workspace/aiContext';
import { useI18n } from '../i18n';
import './editor-actions.css';

export function EditorActions({
  disabled,
  opening,
  onOpenVSCode,
}: {
  disabled: boolean;
  opening: boolean;
  onOpenVSCode(): Promise<void>;
}) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (disabled || opening) setOpen(false);
  }, [disabled, opening]);
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current?.getBoundingClientRect();
    const bounds = menu.current?.getBoundingClientRect();
    if (anchor && bounds)
      setPosition({
        left: Math.max(6, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 6)),
        top: Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 6),
      });
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'Tab') setOpen(false);
    };
    const moved = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', moved);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        className="editor-split-toggle editor-more-toggle"
        disabled={disabled || opening}
        title={t(opening ? 'editor.openingVSCode' : 'editor.more')}
        aria-label={t('editor.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {opening ? (
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
        ) : (
          <MoreHorizontal size={16} aria-hidden="true" />
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="context-menu editor-actions-menu"
            role="menu"
            aria-label={t('editor.more')}
            style={position}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
              ];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                close();
                void onOpenVSCode();
              }}
            >
              <Code2 size={15} aria-hidden="true" />
              <span>{t('editor.openVSCode')}</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                close();
                openAiAssistant();
              }}
            >
              <MessageSquareText size={15} aria-hidden="true" />
              <span>{t('ai.chat.title')}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
