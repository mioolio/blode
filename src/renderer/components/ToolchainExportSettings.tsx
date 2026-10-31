import { useEffect, useRef, useState } from 'react';
import { FileArchive, RefreshCw, X } from 'lucide-react';
import type { ToolVersionsState } from '../../shared/tool-versions';
import { useI18n } from '../i18n';

/** Installed toolchains become portable offline packages from the export section. */
export function ToolchainExportSettings({ busy }: { busy: boolean }) {
  const { t } = useI18n();
  const api = typeof window === 'undefined' ? undefined : window.blode;
  const [state, setState] = useState<ToolVersionsState>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  const unavailable = busy || pending;
  const explain = (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      '',
    );
  const refresh = async () => {
    if (api?.toolVersionsState) setState(await api.toolVersionsState());
  };
  useEffect(() => {
    if (!api?.toolVersionsState) return;
    let cancelled = false;
    void api
      .toolVersionsState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice(t(explain(error)));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const perform = async (action: () => Promise<void>) => {
    if (busy || locked.current) return;
    locked.current = true;
    setPending(true);
    setNotice('');
    try {
      await action();
    } catch (error) {
      setNotice(t(explain(error)));
    } finally {
      locked.current = false;
      setPending(false);
    }
  };
  const exportTool = (id: string) =>
    void perform(async () => {
      if (!api?.toolVersionExport || !api.toolVersionPackageSave)
        throw new Error('settings.versions.restart');
      const result = await api.toolVersionExport({ id, confirm: true });
      await refresh();
      const saved = await api.toolVersionPackageSave(result.id);
      setNotice(t(saved ? 'settings.versions.exported' : 'settings.versions.packageCancelled'));
    });
  const exportable = state?.localTools ?? [];
  return (
    <section className="toolchain-export" aria-label={t('settings.export.title')}>
      <div className="toolchain-export-head">
        <div>
          <h4>{t('settings.export.title')}</h4>
        </div>
        <div className="toolchain-export-actions">
          {pending && (
            <button
              className="text-button"
              onClick={() => void window.blode.toolVersionCancel().catch(() => {})}
            >
              <X size={12} />
              {t('action.cancel')}
            </button>
          )}
          <button className="text-button" disabled={unavailable} onClick={() => void perform(refresh)}>
            <RefreshCw size={12} />
            {t('action.refresh')}
          </button>
        </div>
      </div>
      {!api?.toolVersionsState ? (
        <p className="subtle-note">{t('settings.versions.restart')}</p>
      ) : !state && !notice ? (
        <p className="subtle-note">{t('device.connectionChecking')}</p>
      ) : state && exportable.length === 0 ? (
        <p className="subtle-note">{t('settings.export.empty')}</p>
      ) : state ? (
        <div className="tool-version-rows toolchain-export-list">
          {exportable.map((entry) => (
            <article className="tool-version-row installed" key={entry.id}>
              <div className="tool-version-row-main">
                <div className="tool-version-row-title">
                  <strong>{entry.name}</strong>
                  {entry.version && !entry.name.includes(entry.version) && <span>{entry.version}</span>}
                  <span className="package-badge">{t(`settings.versions.source.${entry.source}`)}</span>
                </div>
                {entry.directory && <p className="tool-version-path">{entry.directory}</p>}
              </div>
              <div className="tool-version-row-actions">
                <button
                  disabled={unavailable || !entry.exportable}
                  title={entry.exportable ? undefined : t('settings.export.localOnly')}
                  onClick={() => exportTool(entry.id)}
                >
                  <FileArchive size={13} />
                  {t('settings.versions.exportZip')}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {notice && (
        <p className="tool-version-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
