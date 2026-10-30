import { ModernSelect } from './ModernSelect';
import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { ProjectConfig } from '../../shared/contracts';
import type { ToolVersionsApi, ToolVersionsState } from '../../shared/tool-versions';
import { useI18n } from '../i18n';
import { ToolOfflineActions } from './ToolOfflineActions';

const sourceLabels = {
  managed: 'settings.versions.source.managed',
  versioned: 'settings.versions.source.versioned',
  custom: 'settings.versions.source.custom',
  path: 'settings.versions.source.path',
};

export function ToolVersionSettings({
  config,
  onChange,
  busy,
  workspaceOpen,
}: {
  config: ProjectConfig;
  onChange: (value: ProjectConfig) => void;
  busy: boolean;
  workspaceOpen: boolean;
}) {
  const { t } = useI18n();
  const api: Partial<ToolVersionsApi> = typeof window === 'undefined' ? {} : window.blode;
  const [state, setState] = useState<ToolVersionsState>();
  const [tab, setTab] = useState<'installed' | 'catalog'>('installed');
  const [selected, setSelected] = useState('');
  const [localSelected, setLocalSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [offlinePending, setOfflinePending] = useState(false);
  const unavailable = busy || pending || offlinePending;
  const [notice, setNotice] = useState('');
  const acceptState = (next: ToolVersionsState) => {
    setState(next);
    setSelected((current) =>
      next.entries.some((entry) => entry.id === current)
        ? current
        : (next.entries.find(
            (entry) => entry.kind === (config.boardId === 'STM32F103C8T6' ? 'gnu-arm' : 'arduino-esp32'),
          )?.id ??
          next.entries[0]?.id ??
          ''),
    );
    setLocalSelected((current) => {
      const installed = next.installedTools ?? [];
      return installed.some((entry) => entry.id === current)
        ? current
        : (installed.find((entry) =>
            entry.platforms.includes(config.boardId as 'STM32F103C8T6' | 'Esp32_S3_CAM'),
          )?.id ??
            installed[0]?.id ??
            '');
    });
  };
  const refresh = async () => {
    if (api.toolVersionsState) acceptState(await api.toolVersionsState());
  };
  useEffect(() => {
    void refresh().catch((error) => setNotice(String(error)));
  }, []);
  const entry = state?.entries.find((item) => item.id === selected);
  const local = state?.installedTools?.find((item) => item.id === localSelected);
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    setNotice('');
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNotice(t(text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')));
    } finally {
      setPending(false);
    }
  };
  const useTool = (id: string) =>
    void perform(async () => {
      const patch = await api.toolVersionSelect!({ id });
      onChange({ ...config, toolchain: { ...config.toolchain, ...patch } });
      setNotice(t('settings.versions.selected'));
    });
  return (
    <section className="tool-versions" aria-label={t('settings.versions.title')}>
      <div className="settings-card-head">
        <h3>{t('settings.versions.title')}</h3>
        <button className="text-button" disabled={unavailable} onClick={() => void perform(refresh)}>
          <RefreshCw size={12} />
          {t('action.refresh')}
        </button>
      </div>
      {!api.toolVersionsState ? (
        <p className="subtle-note">{t('settings.versions.restart')}</p>
      ) : (
        <>
          <div className="tool-version-tabs" role="tablist" aria-label={t('settings.versions.title')}>
            <button
              role="tab"
              aria-selected={tab === 'installed'}
              className={tab === 'installed' ? 'active' : ''}
              onClick={() => setTab('installed')}
            >
              {t('settings.versions.local')}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'catalog'}
              className={tab === 'catalog' ? 'active' : ''}
              onClick={() => setTab('catalog')}
            >
              {t('settings.versions.catalog')}
            </button>
          </div>
          {tab === 'installed' ? (
            <div className="tool-version-panel" role="tabpanel">
              {!state ? (
                <p className="subtle-note">{t('device.connectionChecking')}</p>
              ) : !state.installedTools ? (
                <p className="subtle-note">{t('settings.versions.restart')}</p>
              ) : !state.installedTools.length ? (
                <p className="subtle-note">{t('settings.versions.localEmpty')}</p>
              ) : (
                <>
                  <label>
                    {t('settings.versions.localChoose')}
                    <ModernSelect
                      value={localSelected}
                      disabled={unavailable}
                      onChange={(event) => setLocalSelected(event.target.value)}
                    >
                      {state.installedTools.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {t(sourceLabels[item.source])}
                        </option>
                      ))}
                    </ModernSelect>
                  </label>
                  {local && (
                    <>
                      <dl className="tool-installed-details">
                        {local.directory && (
                          <>
                            <dt>{t('settings.versions.toolDirectory')}</dt>
                            <dd>{local.directory}</dd>
                          </>
                        )}
                        {local.arduinoCli && (
                          <>
                            <dt>{t('settings.versions.cliPath')}</dt>
                            <dd>{local.arduinoCli}</dd>
                          </>
                        )}
                        {local.packageDirectory && (
                          <>
                            <dt>{t('settings.versions.coreStore')}</dt>
                            <dd>{local.packageDirectory}</dd>
                          </>
                        )}
                      </dl>
                      <div className="tool-version-actions">
                        <button
                          className="primary"
                          disabled={unavailable || !workspaceOpen}
                          onClick={() => useTool(local.id)}
                        >
                          {t('settings.versions.use')}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="tool-version-panel" role="tabpanel">
              <label>
                {t('settings.versions.choose')}
                <ModernSelect
                  value={selected}
                  disabled={unavailable}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setNotice('');
                  }}
                >
                  {['gnu-arm', 'arduino-cli', 'arduino-esp32', 'stlink'].map((kind) => (
                    <optgroup key={kind} label={kind}>
                      {state?.entries
                        .filter((item) => item.kind === kind)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                            {item.installed ? ' · ' + t('settings.available') : ''}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </ModernSelect>
              </label>
              {entry && (
                <>
                  <div className="tool-version-meta">
                    <span>
                      {state?.platform} / {state?.arch}
                    </span>
                    <a href={entry.releaseUrl} target="_blank" rel="noreferrer">
                      {t('settings.versions.release')}
                    </a>
                    {entry.downloadUrl && (
                      <a href={entry.downloadUrl} target="_blank" rel="noreferrer">
                        {t('settings.versions.downloadLink')}
                      </a>
                    )}
                  </div>
                  {entry.note && <p className="subtle-note">{t(entry.note)}</p>}
                  {state?.platform === 'linux' && (
                    <p className="subtle-note">{t('settings.versions.linuxNote')}</p>
                  )}
                  <div className="tool-version-actions">
                    <button
                      className="secondary"
                      disabled={unavailable || !entry.installable || entry.installed}
                      onClick={() =>
                        void perform(async () => {
                          acceptState(await api.toolVersionInstall!({ id: entry.id, confirm: true }));
                          setNotice(t('settings.versions.installed'));
                        })
                      }
                    >
                      <Download size={13} />
                      {t('settings.versions.install')}
                    </button>
                    <button
                      className="primary"
                      disabled={unavailable || !workspaceOpen || !entry.installed}
                      onClick={() => useTool(entry.id)}
                    >
                      {t('settings.versions.use')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      {notice && (
        <p className="tool-version-notice" role="status">
          {notice}
        </p>
      )}
      <ToolOfflineActions
        entry={tab === 'catalog' ? entry : undefined}
        state={state}
        disabled={busy || pending}
        onInstalled={acceptState}
        onPendingChange={setOfflinePending}
      />
    </section>
  );
}
