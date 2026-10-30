import { CircleCheck, CircleX, Download, LoaderCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { InstallationProgress, InstallationState } from '../../shared/contracts';
import { useI18n } from '../i18n';
import './installation-output.css';

const phaseKeys: Record<InstallationProgress['phase'], string> = {
  starting: 'status.installStarting',
  downloading: 'status.installDownloading',
  verifying: 'status.installVerifying',
  extracting: 'status.installExtracting',
  installing: 'status.installInstalling',
  completed: 'status.installCompleted',
  failed: 'status.installFailed',
};

const bytesLabel = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;

/** Shared by preferences and the separate debugger window. */
export function InstallationOutput({
  installation,
  pending = false,
}: {
  installation?: InstallationState;
  pending?: boolean;
}) {
  const { t } = useI18n();
  const output = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const pendingSince = useRef<number | null>(null);
  if (pending && pendingSince.current === null) pendingSince.current = Date.now();
  if (!pending) pendingSince.current = null;
  // The button responds immediately while the native installer is being started.
  const waiting =
    pending &&
    installation?.status !== 'running' &&
    (!installation || Date.parse(installation.updatedAt) < (pendingSince.current ?? 0));
  const current = waiting ? undefined : installation;
  const running = waiting || current?.status === 'running';
  const phase = waiting ? 'starting' : current?.phase;
  const received = current?.receivedBytes;
  const total = current?.totalBytes;
  const canMeasure =
    phase === 'downloading' &&
    typeof received === 'number' &&
    Number.isFinite(received) &&
    received >= 0 &&
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0;
  const percent = canMeasure ? Math.min(100, Math.max(0, (received / total) * 100)) : undefined;
  const logs = current?.logs.filter((entry) => !entry.progressOnly).slice(-250) ?? [];
  const phaseLabel = phase
    ? t(
        phase === 'completed' && current?.operation === 'download'
          ? 'status.downloadCompleted'
          : phaseKeys[phase],
      )
    : t('settings.installIdle');
  const status = running ? 'running' : (current?.status ?? 'idle');

  useEffect(() => {
    followOutput.current = true;
  }, [current?.id]);
  useEffect(() => {
    const panel = output.current;
    if (panel && followOutput.current) panel.scrollTop = panel.scrollHeight;
  }, [current?.id, current?.updatedAt, logs.length]);

  return (
    <section className={`settings-card installation-output installation-${status}`}>
      <div className="installation-heading">
        <h3>{t('settings.installOutput')}</h3>
        <span className="installation-status" role="status" aria-live="polite">
          {running ? (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          ) : status === 'completed' ? (
            <CircleCheck size={14} aria-hidden="true" />
          ) : status === 'failed' ? (
            <CircleX size={14} aria-hidden="true" />
          ) : (
            <Download size={14} aria-hidden="true" />
          )}
          {phaseLabel}
        </span>
      </div>
      {!current && !waiting ? (
        <p className="installation-empty">{t('settings.installOutputHint')}</p>
      ) : (
        <>
          <div className="installation-detail">
            <strong>{current?.tool || t('settings.installPreparing')}</strong>
            {phase === 'downloading' && typeof received === 'number' && (
              <span>
                {bytesLabel(received)}
                {canMeasure ? ` / ${bytesLabel(total)} · ${percent!.toFixed(0)}%` : ''}
              </span>
            )}
          </div>
          {running && (
            <div
              className={`installation-progress ${percent === undefined ? 'indeterminate' : ''}`}
              role="progressbar"
              aria-label={`${current?.tool ?? t('settings.installPreparing')} · ${phaseLabel}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
            </div>
          )}
          <div
            className="installation-log"
            ref={output}
            role="log"
            aria-label={t('settings.installOutput')}
            aria-live="off"
            tabIndex={0}
            onScroll={(event) => {
              const panel = event.currentTarget;
              followOutput.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
            }}
          >
            {logs.length ? (
              logs.map((entry, index) => (
                <div className={`installation-log-line level-${entry.level}`} key={`${entry.time}-${index}`}>
                  <time>{new Date(entry.time).toLocaleTimeString([], { hour12: false })}</time>
                  <span>{t(entry.message)}</span>
                </div>
              ))
            ) : (
              <span className="installation-log-empty">{phaseLabel}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
