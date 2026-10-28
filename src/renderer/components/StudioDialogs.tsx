import {
  Bug,
  CircleAlert,
  CircleCheck,
  Cpu,
  Download,
  Flame,
  ScanSearch,
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
    probeFailure,
    downloadProbeLog,
    sendProbeFeedback,
    chooseBoardManually,
  } = studio;
  // Tool output can be long; the protocol key is the readable summary and the log keeps details.
  const probeDetail =
    probeFailure && /^(?:error|errors)\./.test(probeFailure.message)
      ? t(probeFailure.message)
      : t('error.probeFailed');
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
      {probeFailure && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-heading">
              <span className="modal-icon warning">
                <ScanSearch size={17} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <h2>{t('dialog.probeFailedTitle')}</h2>
            </div>
            <p>{t('dialog.probeFailedBody')}</p>
            <p className="subtle-note">{probeDetail}</p>
            <div className="modal-actions">
              <button className="secondary" onClick={sendProbeFeedback}>
                <Bug size={13} strokeWidth={1.9} aria-hidden="true" />
                {t('dialog.feedback')}
              </button>
              <button className="secondary" onClick={downloadProbeLog}>
                <Download size={13} strokeWidth={1.9} aria-hidden="true" />
                {t('dialog.downloadLog')}
              </button>
              <button className="primary" onClick={chooseBoardManually}>
                {t('dialog.manualBoard')}
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
