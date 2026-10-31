import { useEffect, useRef, useState } from 'react';
import { Check, Download, ExternalLink, FolderOpen, RefreshCw, X } from 'lucide-react';
import type { ProjectConfig } from '../../shared/contracts';
import type { ToolVersionKind, ToolVersionsApi, ToolVersionsState } from '../../shared/tool-versions';
import { useI18n } from '../i18n';
import { pickHostPath } from '../workspace/hostPicker';
import { ModernSelect } from './ModernSelect';

const names: Record<ToolVersionKind, string> = {
  'gnu-arm': 'GNU Arm GCC',
  'arduino-cli': 'Arduino CLI',
  'arduino-esp32': 'Arduino-ESP32',
  stlink: 'ST-Link',
  clangd: 'clangd',
};
export function ToolVersionSettings({
  busy,
}: {
  config?: ProjectConfig;
  onChange?: (value: ProjectConfig) => void;
  busy: boolean;
  workspaceOpen: boolean;
}) {
  const { t } = useI18n();
  const api: Partial<ToolVersionsApi> = typeof window === 'undefined' ? {} : window.blode;
  const [state, setState] = useState<ToolVersionsState>();
  const [kind, setKind] = useState<ToolVersionKind>('gnu-arm');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    let active = true;
    void api
      .toolVersionsState?.()
      .then((next) => {
        if (active) setState(next);
      })
      .catch((error) => {
        if (active) setNotice(String(error));
      });
    return () => {
      active = false;
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
      setNotice(
        t(
          (error instanceof Error ? error.message : String(error)).replace(
            /^Error invoking remote method '[^']+': (?:Error: )?/,
            '',
          ),
        ),
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  };
  const unavailable = busy || pending;
  return (
    <section className="tool-catalog" aria-label={t('settings.versions.title')}>
      <div className="tool-catalog-toolbar">
        <label className="tool-catalog-filter">
          <span>{t('buildSettings.family')}</span>
          <ModernSelect value={kind} onChange={(event) => setKind(event.target.value as ToolVersionKind)}>
            {Object.entries(names).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </ModernSelect>
        </label>
        <button
          disabled={unavailable || !api.toolVersionImport}
          onClick={() =>
            void perform(async () => {
              const file = await pickHostPath({ kind: 'file', extensions: ['zip'] });
              if (file) {
                setState(await api.toolVersionImport!({ path: file, confirm: true }));
                setNotice(t('settings.versions.imported'));
              }
            })
          }
        >
          <FolderOpen size={14} />
          {t('settings.versions.importOffline')}
        </button>
        <button
          className="icon-button"
          disabled={unavailable || !api.toolVersionsState}
          title={t('action.refresh')}
          aria-label={t('action.refresh')}
          onClick={() => void perform(async () => setState(await api.toolVersionsState!()))}
        >
          <RefreshCw size={15} />
        </button>
        {pending && (
          <button className="text-button" onClick={() => void api.toolVersionCancel?.()}>
            <X size={14} />
            {t('action.cancel')}
          </button>
        )}
      </div>
      {!api.toolVersionsState ? (
        <p className="subtle-note">{t('settings.versions.restart')}</p>
      ) : !state ? (
        <p role="status">{t('device.connectionChecking')}</p>
      ) : (
        <div className="tool-catalog-table" role="table" aria-label={names[kind]}>
          <div className="tool-catalog-row tool-catalog-labels" role="row">
            <span role="columnheader">{t('buildSettings.version')}</span>
            <span role="columnheader">{t('settings.catalog.state')}</span>
            <span role="columnheader">{t('settings.catalog.actions')}</span>
          </div>
          {state.entries
            .filter((entry) => entry.kind === kind)
            .map((entry) => (
              <div className="tool-catalog-row" role="row" key={entry.id}>
                <div role="cell" className="tool-catalog-version">
                  <strong>{entry.version}</strong>
                  <a
                    href={entry.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={t('settings.versions.release')}
                    aria-label={t('settings.versions.release')}
                  >
                    <ExternalLink size={13} />
                  </a>
                </div>
                <span role="cell" className="tool-catalog-state">
                  {entry.installed && <Check size={13} />}{' '}
                  {t(entry.installed ? 'settings.versions.installedBadge' : 'settings.versions.notInstalled')}
                </span>
                <div role="cell" className="tool-catalog-actions">
                  {!entry.installed && entry.installable && (
                    <button
                      className="primary"
                      disabled={unavailable}
                      onClick={() =>
                        void perform(async () => {
                          setState(await api.toolVersionInstall!({ id: entry.id, confirm: true }));
                          setNotice(t('settings.versions.installed'));
                        })
                      }
                    >
                      <Download size={13} />
                      {t('settings.catalog.install')}
                    </button>
                  )}
                  {entry.installable ? (
                    <button
                      disabled={unavailable}
                      onClick={() =>
                        void perform(async () => {
                          const result = await api.toolVersionDownload!({ id: entry.id, confirm: true });
                          const saved = await api.toolVersionPackageSave!(result.id);
                          setNotice(t(saved ? 'settings.versions.packageSaved' : 'action.cancelled'));
                        })
                      }
                    >
                      {t('settings.catalog.download')}
                    </button>
                  ) : entry.downloadUrl ? (
                    <a href={entry.downloadUrl} target="_blank" rel="noreferrer">
                      {t('settings.versions.downloadLink')}
                    </a>
                  ) : (
                    <a href={entry.releaseUrl} target="_blank" rel="noreferrer">
                      {t('settings.versions.release')}
                    </a>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
      {notice && (
        <p className="tool-version-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
