import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info, X } from 'lucide-react';
import { useI18n } from '../i18n';
import './context-help.css';

/** Optional help stays outside the main task layout and uses native modal focus handling. */
export function ContextHelp({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const view = dialog.current;
    view?.showModal();
    return () => {
      view?.close();
      trigger.current?.focus();
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="context-help-trigger"
        aria-label={title}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <dialog
            ref={dialog}
            className="context-help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onCancel={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
              )
                setOpen(false);
            }}
          >
            <header>
              <h3 id={titleId}>{title}</h3>
              <button className="icon-button" aria-label={t('action.close')} onClick={() => setOpen(false)}>
                <X size={17} />
              </button>
            </header>
            <div className="context-help-content">{children}</div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
