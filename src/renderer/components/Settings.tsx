import { CircleCheck, CircleX, Download, RefreshCw, Save, Usb } from 'lucide-react';
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

export type PreferencesSection = 'general' | 'toolchain' | 'drivers';

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
  onInstall: () => void;
  onInstallDriver: (id: DriverId) => void;
  onRefreshDrivers: () => void;
  busy: boolean;
  isWeb: boolean;
}

const tools = [
  { id: 'arduinoCli', name: 'Arduino CLI', versionKey: 'arduinoCli' },
  { id: 'esp32Core', name: 'Arduino-ESP32', versionKey: 'esp32' },
  { id: 'python', name: 'Python', versionKey: 'python' },
  { id: 'esptool', name: 'esptool', versionKey: 'esptool' },
] as const;

export function Settings({
  target,
  config,
  status,
  drivers,
  installation,
  installPending,
  workspaceOpen,
  onChange,
  onSave,
  onInstall,
  onInstallDriver,
  onRefreshDrivers,
  busy,
  isWeb,
}: Props) {
  const { t, locale, setLocale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const installationPanel = useRef<HTMLDivElement>(null);
  const isAutomatic = config.boardId === 'auto';
  const usesStlink = config.boardId === 'stm32' || config.programmer?.transport === 'stlink';
  const stlinkTool = { id: 'stlink' as const, name: 'stlink-tools', versionKey: 'stlink' };
  const armCompilerTool = { id: 'armCompiler' as const, name: 'Arm Compiler 6', versionKey: 'armCompiler' };
  const gnuTool = { id: 'gnuArm' as const, name: 'GNU Arm GCC', versionKey: 'gnuArm' };
  const shownTools = isAutomatic
    ? [...tools, stlinkTool, armCompilerTool, gnuTool]
    : usesStlink
      ? [stlinkTool, armCompilerTool, gnuTool]
      : tools;
  useEffect(() => {
    if (!target) return;
    const section = container.current?.querySelector<HTMLElement>(
      `[data-preferences-section="${target.section}"]`,
    );
    if (target.section !== 'general') section?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [target]);
  useEffect(() => {
    if (installPending || installation?.status === 'running')
      installationPanel.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
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
      <span className="subtle-note">{t('settings.armCompilerNote')}</span>
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
    <div className="settings-view view-scroll" ref={container}>
      <div className="settings-toolbar">
        <span className="workspace-note">{t('settings.subtitle')}</span>
        {workspaceOpen && (
          <button className="primary" onClick={onSave} disabled={busy}>
            <Save size={13} strokeWidth={1.9} aria-hidden="true" />
            {t('action.apply')}
          </button>
        )}
      </div>
      <div ref={installationPanel}>
        <InstallationOutput installation={installation} pending={installPending} />
      </div>
      <section className="settings-card" data-preferences-section="general" tabIndex={-1}>
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
            <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
              <option value="zh-CN">{t('language.zh-CN')}</option>
              <option value="en">{t('language.en')}</option>
            </select>
          </label>
        </div>
        {!workspaceOpen && <p className="subtle-note">{t('settings.openProjectFirst')}</p>}
      </section>
      <section className="settings-card" data-preferences-section="toolchain" tabIndex={-1}>
        <h3>{t('settings.toolchain')}</h3>
        <fieldset disabled={busy || !workspaceOpen} style={{ display: 'contents' }}>
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
          <p className="subtle-note">
            {t(
              isAutomatic
                ? 'settings.autoToolchainNote'
                : usesStlink
                  ? 'settings.stlinkNote'
                  : 'settings.note',
            )}
          </p>
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
        <button
          className="secondary"
          onClick={onInstall}
          disabled={busy || isWeb || installation?.status === 'running'}
        >
          <Download size={13} strokeWidth={1.9} aria-hidden="true" />
          {t('action.install')}
        </button>
      </section>
      <section className="settings-card" data-preferences-section="drivers" tabIndex={-1}>
        <div className="settings-card-head">
          <h3>{t('settings.drivers')}</h3>
          <button className="text-button" onClick={onRefreshDrivers} disabled={busy}>
            <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
            {t('action.refresh')}
          </button>
        </div>
        <p className="subtle-note">{t('settings.driverNote')}</p>
        {drivers.map((driver) => {
          const ok =
            driver.state === 'ready' || driver.state === 'installed' || driver.state === 'unsupported';
          const canInstall =
            driver.supported && driver.available && !busy && !isWeb && installation?.status !== 'running';
          return (
            <div className={`driver-item ${ok ? 'driver-ok' : 'driver-attention'}`} key={driver.id}>
              <div className="driver-line">
                {ok ? (
                  <CircleCheck size={14} strokeWidth={1.9} className="tone-ok" aria-hidden="true" />
                ) : (
                  <CircleX size={14} strokeWidth={1.9} className="tone-missing" aria-hidden="true" />
                )}
                <span className="driver-name">{driver.name}</span>
                <span className="driver-state">{driverState(driver.state)}</span>
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
                  {driver.installed || driver.state === 'ready' ? t('driver.reinstall') : t('driver.install')}
                </button>
              </div>
              {driver.state === 'device-unbound' && <p className="subtle-note">{t('driver.unboundHint')}</p>}
              {driver.supported && !driver.available && (
                <p className="subtle-note">{t('driver.packageMissing')}</p>
              )}
              {!driver.supported && <p className="subtle-note">{t('driver.windowsOnly')}</p>}
              {isWeb && <p className="subtle-note">{t('driver.desktopOnly')}</p>}
            </div>
          );
        })}
        <p className="subtle-note">{t('driver.uacHint')}</p>
      </section>
      <section className="settings-card">
        <h3>{t('settings.status')}</h3>
        <div className="toolchain-grid">
          {shownTools.map(({ id, name, versionKey }) => (
            <div className="toolchain-item" key={id}>
              {status[id] ? (
                <CircleCheck size={14} strokeWidth={1.9} className="tone-ok" aria-hidden="true" />
              ) : (
                <CircleX size={14} strokeWidth={1.9} className="tone-missing" aria-hidden="true" />
              )}
              <span>{name}</span>
              <small>
                {status.versions[versionKey] || t(status[id] ? 'settings.available' : 'settings.missing')}
              </small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
