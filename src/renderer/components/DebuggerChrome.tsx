import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';

export interface DebuggerMenu {
  label: string;
  items: { label: string; run: () => void; disabled?: boolean; checked?: boolean }[];
}

export function DebuggerMenubar({ menus, label }: { menus: DebuggerMenu[]; label: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLElement>(null);
  const prefix = useId();
  const trigger = (index: number) =>
    root.current?.querySelectorAll<HTMLButtonElement>(':scope > div > button')[index];
  const focusItem = (last = false) => {
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menu"] button:not(:disabled)');
    items?.[last ? items.length - 1 : 0]?.focus();
  };
  useEffect(() => {
    if (open === null) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open !== null) focusItem();
  }, [open]);
  return (
    <nav
      className="debug-menubar menu-items ide-menubar"
      aria-label={label}
      role="menubar"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open !== null) {
          event.preventDefault();
          trigger(open)?.focus();
          setOpen(null);
        }
      }}
    >
      {menus.map((menu, index) => (
        <div className="debug-menu-group ide-menu" key={menu.label}>
          <button
            type="button"
            className="ide-menu-trigger"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            aria-controls={`${prefix}-${index}`}
            onClick={() => setOpen(open === index ? null : index)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setOpen(index);
                if (open === index) focusItem();
              } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                trigger(
                  (index + (event.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length,
                )?.focus();
              }
            }}
          >
            {menu.label}
          </button>
          {open === index && (
            <div
              role="menu"
              id={`${prefix}-${index}`}
              aria-label={menu.label}
              className="debug-menu-popup ide-menu-popup"
              onKeyDown={(event) => {
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
                );
                const position = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  buttons[
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? buttons.length - 1
                        : (position + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
                  ]?.focus();
                } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault();
                  setOpen((index + (event.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length);
                }
              }}
            >
              {menu.items.map((item) => (
                <button
                  type="button"
                  className="ide-menu-item"
                  key={item.label}
                  role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={item.checked}
                  disabled={item.disabled}
                  onClick={() => {
                    trigger(index)?.focus();
                    setOpen(null);
                    item.run();
                  }}
                >
                  <span>{item.label}</span>
                  {item.checked && <Check size={13} />}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

export function DebuggerDialog({
  title,
  closeLabel,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog
      className="debug-dialog"
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={closeLabel}
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="debug-dialog-body">{children}</div>
    </dialog>,
    document.body,
  );
}
