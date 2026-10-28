import {
  CircleAlert,
  CircleCheck,
  Cpu,
  Flame,
  Trash2,
  Usb,
  X,
} from 'lucide-react';
import type { Studio } from '../workspace/useStudio';

/** StudioDialogs renders one workspace surface; application actions stay in useStudio. */
export function StudioDialogs({ studio }: { studio: Studio }) {
  const {
    t,
    toast,
    setToast,
    deleteTarget,
    setDeleteTarget,
    removeEntry,
    confirmFlash,
    setConfirmFlash,
    busy,
    config,
    board,
    perform,
    refresh,
    setTab,
    notify,
  } = studio;
  return (
    <>
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          <span className={`toast-icon ${toast.error ? 'error' : 'success'}`}>
            {toast.error ? (
              <CircleAlert size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <CircleCheck size={16} strokeWidth={2} aria-hidden="true" />
            )}
          </span>
          <span>{toast.message}</span>
          <button className="toast-close" aria-label={t('action.close')} onClick={() => setToast(null)}>
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}
      {confirmFlash && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-heading">
              <span className="modal-icon warning">
                <Flame size={17} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <h2>{t('dialog.flashTitle')}</h2>
            </div>
            <p>{t('dialog.flashBody')}</p>
            <div className="flash-target">
              <span className="flash-target-item">
                <Cpu size={13} strokeWidth={1.8} aria-hidden="true" />
                {board?.name}
              </span>
              <span className="flash-target-item">
                <Usb size={13} strokeWidth={1.8} aria-hidden="true" />
                {config?.port}
              </span>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmFlash(false)}>
                {t('action.cancel')}
              </button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmFlash(false);
                  void perform('action.flash', async () => {
                    setTab('output');
                    await window.blode.flash();
                    await refresh();
                    notify(t('toast.flashed'));
                  });
                }}
              >
                <Flame size={13} strokeWidth={1.9} aria-hidden="true" />
                {t('dialog.confirmFlash')}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-heading">
              <span className="modal-icon warning">
                <Trash2 size={17} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <h2>{t('dialog.deleteTitle')}</h2>
            </div>
            <p>{t('dialog.deleteBody')}</p>
            <div className="flash-target">
              <span className="flash-target-item">
                <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                {deleteTarget}
              </span>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setDeleteTarget(null)}>
                {t('action.cancel')}
              </button>
              <button className="primary danger" onClick={() => void removeEntry()} disabled={!!busy}>
                <Trash2 size={13} strokeWidth={1.9} aria-hidden="true" />
                {t('action.deleteEntry')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
