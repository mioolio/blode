import { ModernSelect } from './ModernSelect';
import { Bot, CircleCheck, CircleX, RefreshCw, Save, Settings2, Terminal, Usb, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  DriverId,
  DriverStatus,
  InstallationState,
  ProjectConfig,
  ToolchainStatus,
} from '../../shared/contracts';
import { useI18n, type Locale } from '../i18n';
import { InstallationOutput } from './InstallationOutput';
import { AiCompletionSettings } from './AiCompletionSettings';
import { ContextHelp } from './ContextHelp';
import { ToolVersionSettings } from './ToolVersionSettings';
import { ToolchainExportSettings } from './ToolchainExportSettings';
import type { DesktopLifecycleState } from '../../shared/desktop-lifecycle';
import './preferences.css';

export type PreferencesSection = 'general' | 'toolchain' | 'drivers' | 'ai' | 'status' | 'installation';

interface Props {
  target?: { section: PreferencesSection; revision: number };
  config: ProjectConfig;
  status: ToolchainStatus;
  drivers: DriverStatus[];
  installation?: InstallationState;
  installPending?: boolean;
  workspaceOpen: boolean;
  onChange: (value: ProjectConfig) => void;
  onSave: () => void;
  onInstallDriver: (id: DriverId) => void;
  onRefreshDrivers: () => void;
  busy: boolean;
  isWeb: boolean;
  initializing?: boolean;
}

export function Settings({
  target,
  config,
  drivers,
  installation,
  installPending,
  workspaceOpen,
  onChange,
  onSave,
  onInstallDriver,
  onRefreshDrivers,
  busy,
  isWeb,
  initializing = false,
}: Props) {
  const { t, locale, setLocale } = useI18n();
  const [desktop, setDesktop] = useState<DesktopLifecycleState>();
  const [desktopError, setDesktopError] = useState('');
  const desktopRevision = useRef(0);
  useEffect(() => {
    if (isWeb || typeof window.blode.desktopLifecycleState !== 'function') return;
    let cancelled = false;
    const revision = desktopRevision.current;
    void window.blode
      .desktopLifecycleState()
      .then(async (state) => {
        if (cancelled || revision !== desktopRevision.current) return;
        const next =
          state.locale === locale
            ? state
            : await window.blode.desktopLifecycleConfigure({ closeToTray: state.closeToTray, locale });
        if (!cancelled && revision === desktopRevision.current) setDesktop(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDesktopError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [isWeb, locale]);
  const [active, setActive] = useState<PreferencesSection>(target?.section ?? 'general');
  const [visited, setVisited] = useState<ReadonlySet<PreferencesSection>>(
    () => new Set([target?.section ?? 'general']),
  );
  useEffect(() => {
    setVisited((current) => (current.has(active) ? current : new Set([...current, active])));
  }, [active]);
  const container = useRef<HTMLDivElement>(null);
  const installationPanel = useRef<HTMLDivElement>(null);
  const isAutomatic = config.boardId === 'auto';
  const usesStlink = config.boardId === 'STM32F103C8T6' || config.programmer?.transport === 'stlink';
  useEffect(() => {
    if (!target) return;
    setActive(target.section);
  }, [target]);
  useEffect(() => {
    if (installPending || installation?.status === 'running') setActive('installation');
  }, [installation?.id, installPending]);
  const [urlsText, setUrlsText] = useState(config.toolchain.additionalUrls.join('\n'));
  const urlsCanonical = config.toolchain.additionalUrls.join('\n');
  useEffect(() => {
    // Preserve a trailing newline while typing a second URL, but follow external config changes.
    if (
      urlsText
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
        .join('\n') !== urlsCanonical
    )
      setUrlsText(urlsCanonical);
  }, [urlsCanonical]);
  const tool = (values: Partial<ProjectConfig['toolchain']>) =>
    onChange({ ...config, toolchain: { ...config.toolchain, ...values } });
  const serialToolPaths = (
    <div className="form-two">
      <label>
        {t('settings.cli')}
        <input
          value={config.toolchain.arduinoCli}
          placeholder={'C:\\tools\\arduino-cli.exe'}
          onChange={(event) => tool({ arduinoCli: event.target.value })}
        />
      </label>
      <label>
        {t('settings.python')}
        <input
          value={config.toolchain.python}
          placeholder="python"
          onChange={(event) => tool({ python: event.target.value })}
        />
      </label>
    </div>
  );
  const stlinkToolPath = (
    <label>
      {t('settings.stlinkDirectory')}
      <input
        value={config.toolchain.stlinkDirectory ?? ''}
        placeholder={'C:\\tools\\stlink\\bin'}
        onChange={(event) => tool({ stlinkDirectory: event.target.value })}
      />
    </label>
  );
  const armCompilerToolPath = (
    <label>
      {t('settings.armCompilerDirectory')}
      <input
        value={config.toolchain.armCompilerDirectory ?? ''}
        placeholder={'C:\\tools\\armclang\\bin'}
        onChange={(event) => tool({ armCompilerDirectory: event.target.value })}
      />
    </label>
  );
  const driverState = (state: DriverStatus['state']) => {
    if (state === 'ready') return t('driver.state.ready');
    if (state === 'installed') return t('driver.state.installed');
    if (state === 'device-unbound') return t('driver.state.unbound');
    if (state === 'missing') return t('driver.state.missing');
    return t('driver.state.unsupported');
  };

  return (
    <div className="settings-view preferences-shell" ref={container}>
      <nav className="preferences-navigation" aria-label={t('menu.preferences')}>
        {(
          [
            ['general', 'settings.general', Settings2],
            ['toolchain', 'settings.toolchain', Wrench],
            ['drivers', 'settings.drivers', Usb],
            ['ai', 'ai.completions.title', Bot],
            ['status', 'settings.status', CircleCheck],
            ['installation', 'settings.installOutput', Terminal],
          ] as const
        ).map(([id, key, Icon]) => (
          <button
            key={id}
            className={active === id ? 'active' : ''}
            aria-current={active === id ? 'page' : undefined}
            onClick={() => setActive(id)}
          >
            <Icon size={15} aria-hidden="true" />
            {t(key)}
            {id === 'installation' && installation?.status === 'running' && (
              <span className="preferences-running" />
            )}
          </button>
        ))}
      </nav>
      <main className="preferences-detail">
        {workspaceOpen && (
          <div className="settings-toolbar">
            <button className="primary" onClick={onSave} disabled={busy}>
              <Save size={13} strokeWidth={1.9} aria-hidden="true" />
              {t('action.apply')}
            </button>
          </div>
        )}
        <div ref={installationPanel} hidden={active !== 'installation'}>
          <InstallationOutput installation={installation} pending={installPending} />
        </div>
        <section
          className="settings-card"
          data-preferences-section="general"
          hidden={active !== 'general'}
          tabIndex={-1}
        >
          <h3>{t('settings.general')}</h3>
          <div className="form-two">
            <label>
              {t('settings.name')}
              <input
                value={config.name}
                disabled={busy || !workspaceOpen}
                onChange={(event) => onChange({ ...config, name: event.target.value })}
              />
            </label>
            <label>
              {t('settings.language')}
              <ModernSelect value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
                <option value="zh-CN">{t('language.zh-CN')}</option>
                <option value="en">{t('language.en')}</option>
              </ModernSelect>
            </label>
          </div>
          {(desktopError || desktop?.error) && (
            <p className="preferences-option-error" role="alert">
              {t(desktopError || desktop!.error!)}
            </p>
          )}
        </section>
        <div hidden={active !== 'ai'}>
          {(active === 'ai' || visited.has('ai')) && <AiCompletionSettings />}
        </div>
        <section
          className="settings-card"
          data-preferences-section="toolchain"
          hidden={active !== 'toolchain'}
          tabIndex={-1}
        >
          <div className="settings-card-head">
            <h3>{t('settings.toolchain')}</h3>
          </div>
          {active === 'toolchain' && (
            <ToolVersionSettings
              config={config}
              onChange={onChange}
              busy={busy}
              workspaceOpen={workspaceOpen}
            />
          )}
          <details className="tool-path-settings">
            <summary>{t('settings.catalog.paths')}</summary>
            <fieldset disabled={busy || !workspaceOpen} className="tool-path-fields">
              {!isAutomatic && (
                <div className="segmented">
                  <button
                    className={config.toolchain.mode === 'managed' ? 'active' : ''}
                    onClick={() => tool({ mode: 'managed' })}
                  >
                    {t('settings.managed')}
                  </button>
                  <button
                    className={config.toolchain.mode === 'custom' ? 'active' : ''}
                    onClick={() => tool({ mode: 'custom' })}
                  >
                    {t('settings.custom')}
                  </button>
                </div>
              )}
              {isAutomatic ? (
                <>
                  {serialToolPaths}
                  {stlinkToolPath}
                  {armCompilerToolPath}
                </>
              ) : usesStlink ? (
                <>
                  {stlinkToolPath}
                  {armCompilerToolPath}
                </>
              ) : (
                <>
                  {config.toolchain.mode === 'custom' && serialToolPaths}
                  <label>
                    {t('settings.fqbn')}
                    <input
                      value={config.toolchain.fqbn}
                      onChange={(event) => tool({ fqbn: event.target.value })}
                    />
                  </label>
                  <label>
                    {t('settings.urls')}
                    <textarea
                      rows={3}
                      value={urlsText}
                      onChange={(event) => {
                        setUrlsText(event.target.value);
                        tool({
                          additionalUrls: event.target.value
                            .split('\n')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        });
                      }}
                    />
                  </label>
                </>
              )}
            </fieldset>
          </details>
        </section>
        <section
          className="settings-card"
          data-preferences-section="drivers"
          hidden={active !== 'drivers'}
          tabIndex={-1}
        >
          <div className="settings-card-head">
            <h3>{t('settings.drivers')}</h3>
            <ContextHelp title={t('settings.installHelp')}>
              <p>{t('settings.driverNote')}</p>
              <p>{t('driver.uacHint')}</p>
              <p>{t('driver.unboundHint')}</p>
              {isWeb && <p>{t('driver.desktopOnly')}</p>}
            </ContextHelp>
            <button className="text-button" onClick={onRefreshDrivers} disabled={busy || initializing}>
              <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
              {t('action.refresh')}
            </button>
          </div>
          {initializing && (
            <p className="subtle-note" role="status">
              {t('device.connectionChecking')}
            </p>
          )}
          {drivers.map((driver) => {
            const ok =
              driver.state === 'ready' || driver.state === 'installed' || driver.state === 'unsupported';
            const canInstall =
              driver.supported &&
              driver.available &&
              !busy &&
              !initializing &&
              !isWeb &&
              installation?.status !== 'running';
            return (
              <div className={`driver-item ${ok ? 'driver-ok' : 'driver-attention'}`} key={driver.id}>
                <div className="driver-line">
                  {initializing && !ok ? (
                    <RefreshCw size={14} className="muted" aria-hidden="true" />
                  ) : ok ? (
                    <CircleCheck size={14} strokeWidth={1.9} className="tone-ok" aria-hidden="true" />
                  ) : (
                    <CircleX size={14} strokeWidth={1.9} className="tone-missing" aria-hidden="true" />
                  )}
                  <span className="driver-name">{driver.name}</span>
                  <span className="driver-state">
                    {initializing && !ok ? t('device.connectionChecking') : driverState(driver.state)}
                  </span>
                  <small>
                    {driver.version ? `${t('driver.version')} ${driver.version}` : t('driver.versionUnknown')}
                  </small>
                </div>
                <div className="driver-actions">
                  <small>
                    {driver.connected
                      ? `${t('driver.deviceCount')} ${driver.deviceCount}`
                      : t('driver.noDevice')}
                  </small>
                  <button
                    className="secondary"
                    onClick={() => onInstallDriver(driver.id)}
                    disabled={!canInstall}
                  >
                    <Usb size={13} strokeWidth={1.9} aria-hidden="true" />
                    {driver.installed || driver.state === 'ready'
                      ? t('driver.reinstall')
                      : t('driver.install')}
                  </button>
                </div>
                {driver.supported && !driver.available && (
                  <p className="subtle-note">{t('driver.packageMissing')}</p>
                )}
              </div>
            );
          })}
        </section>
        <section className="settings-card" data-preferences-section="status" hidden={active !== 'status'}>
          <h3>{t('settings.status')}</h3>
          {active === 'status' && <ToolchainExportSettings busy={busy} />}
        </section>
      </main>
    </div>
  );
}
