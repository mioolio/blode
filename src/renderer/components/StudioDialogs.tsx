import {
  Bug,
  CircleAlert,
  CircleCheck,
  Cpu,
  Download,
  Flame,
  ScanSearch,
  Trash2,
  TriangleAlert,
  Usb,
  X,
} from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { FileCloseDialog } from './FileCloseDialog';

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
    state,
    config,
    board,
    perform,
    refresh,
    setTab,
    notify,
    probeFailure,
    recentMissing,
    setRecentMissing,
    downloadProbeLog,
    sendProbeFeedback,
    chooseBoardManually,
    isStm32,
    usesStlink,
    validatesFirmware,
  } = studio;
  // Tool output can be long; the protocol key is the readable summary and the log keeps details.
  const probeDetail =
    probeFailure && /^(?:error|errors)\./.test(probeFailure.message)
      ? t(probeFailure.message)
      : t('error.probeFailed');
  const build = state?.lastBuild?.success ? state.lastBuild : null;
  const appRegion = config?.partitions.find((partition) => partition.type === 'app');
  const firmwareUsed = build?.flashUsed ?? 0;
  const overlappedRegions =
    config?.partitions.filter((partition) => partition.type !== 'app' && partition.offset < firmwareUsed) ??
    [];
  const resourceWarning = !!appRegion && (firmwareUsed > appRegion.size || overlappedRegions.length > 0);
  return (
    <>
      <FileCloseDialog studio={studio} />
      {toast && (
        <div className={`toast ${toast.error ? 'error' : toast.warning ? 'warning' : ''}`} role="status">
          <span className={`toast-icon ${toast.error ? 'error' : toast.warning ? 'warning' : 'success'}`}>
            {toast.warning ? (
              <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
            ) : toast.error ? (
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
      {recentMissing && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-heading">
              <span className="modal-icon warning">
                <CircleAlert size={17} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <h2>{t('dialog.recentMissingTitle')}</h2>
            </div>
            <p>{t('dialog.recentMissingBody')}</p>
            <p className="subtle-note">{recentMissing.path}</p>
            <div className="modal-actions">
              <button className="primary" onClick={() => setRecentMissing(null)}>
                {t('action.close')}
              </button>
            </div>
          </div>
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
            <p>
              {t(
                isStm32
                  ? validatesFirmware
                    ? 'dialog.stm32FlashBody'
                    : 'dialog.stm32CompiledFlashBody'
                  : 'dialog.flashBody',
              )}
            </p>
            {resourceWarning && <p className="layout-warning">{t('dialog.resourceWarning')}</p>}
            {overlappedRegions.length > 0 && (
              <p className="layout-warning">
                {t('layout.regionOverlap')} {overlappedRegions.map((partition) => partition.name).join(', ')}
              </p>
            )}
            <div className="flash-target">
              <span className="flash-target-item">
                <Cpu size={13} strokeWidth={1.8} aria-hidden="true" />
                {board?.name}
              </span>
              <span className="flash-target-item">
                <Usb size={13} strokeWidth={1.8} aria-hidden="true" />
                {usesStlink ? `ST-Link ${config?.programmer?.serialNumber ?? ''}` : config?.port}
              </span>
              {isStm32 && (
                <span className="flash-target-item">
                  {t('dialog.flashAddress')} · 0x
                  {(
                    0x08000000 +
                    (config?.partitions.find((partition) => partition.type === 'app')?.offset ?? 0)
                  )
                    .toString(16)
                    .padStart(8, '0')}
                </span>
              )}
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmFlash(false)}>
                {t('action.cancel')}
              </button>
              <button
                className="primary"
                disabled={!!busy}
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
