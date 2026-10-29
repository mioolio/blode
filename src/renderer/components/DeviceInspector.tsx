import { ModernSelect } from './ModernSelect';
import { RuntimeDeviceFields } from './RuntimeDeviceFields';
import { RuntimePluginView } from './RuntimePluginView';
import { CircuitBoard, Cpu, Gauge, RefreshCw, ScanSearch, Usb, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { MemoryUsage } from './MemoryUsage';

export function DeviceInspector({ studio }: { studio: Studio }) {
  const {
    t,
    state,
    config,
    board,
    setConfig,
    busy,
    setStale,
    probe,
    refreshPorts,
    refreshDebugProbes,
    refreshAutoDevices,
    install,
    isStm32,
    isAuto,
    hasBuildEntry,
    usesStlink,
    configDirty,
    saveConfig,
    stale,
    dirty,
    drafts,
  } = studio;
  const workspaceOpen = !!state?.workspaceOpen;
  const plugin = board?.runtimePlugin;
  const pluginTransport = !!plugin && ['usb', 'physical', 'custom'].includes(plugin.transport);
  const hidden = new Set([
    ...(plugin?.ui.hiddenCapabilities ?? []),
    ...(config?.runtime?.disabledCapabilities ?? []),
  ]);
  const hasSerial = !plugin || (plugin.capabilities.includes('serial') && !hidden.has('serial'));
  const initializing = !state || state.initializing === true;
  const debugProbes = state?.debugProbes ?? [];
  const selectedProbe = debugProbes.find(
    (probe) => probe.serialNumber.toLowerCase() === config?.programmer?.serialNumber.toLowerCase(),
  );
  const probeState = state?.connections?.probes.state ?? (debugProbes.length ? 'ready' : 'unknown');
  const probeUncertain = probeState !== 'ready';
  const selectedPort = state?.ports.find((port) => port.path === config?.port);
  const openSerial = state?.connections?.serial;
  const hasPort = !!selectedPort || !!(openSerial?.open && openSerial.port === config?.port);
  const candidates = state?.detection?.candidates ?? [];
  const automaticChoice = isAuto && (!config?.programmer || config.programmer.transport === 'auto');
  const selectedCandidate = candidates.find((candidate) =>
    config?.programmer?.transport === 'stlink'
      ? candidate.transport === 'stlink' &&
        candidate.serialNumber?.toLowerCase() === config.programmer.serialNumber.toLowerCase()
      : config?.programmer?.transport === 'serial'
        ? candidate.transport === 'serial' && candidate.port === config.port
        : candidate.deviceId === config?.runtime?.deviceId &&
          candidate.transport === config?.programmer?.transport,
  );
  const autoDeviceValue = automaticChoice ? '' : (selectedCandidate?.id ?? '');
  const canProbe =
    !initializing &&
    (isAuto ||
      pluginTransport ||
      (usesStlink ? !!selectedProbe || (probeUncertain && !!config?.programmer?.serialNumber) : hasPort));
  const portField = (
    <label>
      <span className="field-label label-with-action">
        <span className="field-label-text">
          <Usb size={12} strokeWidth={1.8} aria-hidden="true" />
          {t(isAuto || usesStlink ? 'device.serialMonitorPort' : 'device.port')}
        </span>
        <button className="text-button" onClick={refreshPorts} disabled={!!busy || initializing}>
          <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
          {t('action.refresh')}
        </button>
      </span>
      <ModernSelect
        value={hasPort || initializing ? (config?.port ?? '') : ''}
        disabled={!config || !!busy || initializing}
        onChange={(event) => config && setConfig({ ...config, port: event.target.value })}
      >
        <option value="">{t(initializing ? 'device.connectionChecking' : 'device.portPlaceholder')}</option>
        {initializing && config?.port && !hasPort && (
          <option value={config.port}>
            {config.port} · {t('device.connectionChecking')}
          </option>
        )}
        {openSerial?.open && !selectedPort && openSerial.port === config?.port && (
          <option value={openSerial.port}>
            {openSerial.port} · {t('status.serialConnected')}
          </option>
        )}
        {state?.ports.map((port) => (
          <option key={port.path} value={port.path}>
            {port.path}
            {port.manufacturer ? ` — ${port.manufacturer}` : ''}
          </option>
        ))}
      </ModernSelect>
    </label>
  );
  return (
    <aside className="device-panel">
      <div className="panel-heading">
        <span className="panel-title">
          <CircuitBoard size={14} strokeWidth={1.8} aria-hidden="true" />
          {t('device.title')}
        </span>
        <button
          className="text-button"
          title={t('view.hideDevicePanel')}
          aria-label={t('view.hideDevicePanel')}
          onClick={() => studio.setDevicePanelVisible(false)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <section className="inspector-section device-config">
        <label>
          <span className="field-label">
            <Cpu size={12} strokeWidth={1.8} aria-hidden="true" />
            {t('device.board')}
          </span>
          <ModernSelect
            aria-label={t('device.board')}
            value={config?.boardId ?? ''}
            disabled={!config || !!busy}
            onChange={(event) => {
              const selected = state?.boards.find((item) => item.id === event.target.value);
              if (config && selected) {
                setConfig({
                  ...config,
                  ...selected.defaultConfig,
                  name: config.name,
                  port: config.port,
                  baudRate:
                    selected.recommendedBaudRate ?? selected.defaultConfig.baudRate ?? config.baudRate,
                  boardId: selected.id,
                  runtime: selected.defaultConfig.runtime
                    ? structuredClone(selected.defaultConfig.runtime)
                    : undefined,
                  programmer: selected.defaultConfig.programmer
                    ? { ...selected.defaultConfig.programmer }
                    : undefined,
                  toolchain: {
                    ...config.toolchain,
                    fqbn: selected.defaultConfig.toolchain?.fqbn ?? config.toolchain.fqbn,
                  },
                });
                setStale(true);
              }
            }}
          >
            {state?.boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </ModernSelect>
        </label>
        {!!state?.runtimePlugins?.errors.length && (
          <details className="subtle-note">
            <summary>
              {t('runtime.loadErrors')} ({state.runtimePlugins.errors.length})
            </summary>
            {state.runtimePlugins.errors.map((error, index) => (
              <p key={index}>
                {error.directory}
                <br />
                {t(error.message)}
              </p>
            ))}
          </details>
        )}
        {state?.runtimePlugins?.plugins.some(
          (item) => item.id === config?.boardId && item.trust === 'required',
        ) && (
          <button
            className="text-button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('blode:runtime-plugin-review', { detail: config?.boardId }),
              )
            }
          >
            {t('runtime.review')}
          </button>
        )}
        {plugin && config && (
          <RuntimeDeviceFields
            plugin={plugin}
            config={config}
            disabled={!!busy || initializing}
            onChange={(value) => {
              setConfig(value);
              setStale(true);
            }}
          />
        )}
        {plugin?.ui.view && <RuntimePluginView id={plugin.id} kind="device" />}
        {isAuto && (
          <label>
            <span className="field-label label-with-action">
              <span className="field-label-text">
                <Usb size={12} strokeWidth={1.8} aria-hidden="true" />
                {t('device.detectDevice')}
              </span>
              <button className="text-button" onClick={refreshAutoDevices} disabled={!!busy || initializing}>
                <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
                {t('action.refresh')}
              </button>
            </span>
            <ModernSelect
              value={autoDeviceValue}
              disabled={!config || !!busy || initializing}
              onChange={(event) => {
                if (!config) return;
                const selected = candidates.find((candidate) => candidate.id === event.target.value);
                if (event.target.value && !selected) return;
                setConfig({
                  ...config,
                  port: selected?.transport === 'serial' ? (selected.port ?? '') : config.port,
                  programmer: {
                    transport: selected?.transport ?? 'auto',
                    serialNumber: selected?.transport === 'stlink' ? (selected.serialNumber ?? '') : '',
                    frequencyKhz: config.programmer?.frequencyKhz ?? 1800,
                  },
                  runtime:
                    selected && !['serial', 'stlink'].includes(selected.transport)
                      ? { ...config.runtime, deviceId: selected.deviceId ?? selected.id }
                      : config.runtime,
                });
                setStale(true);
              }}
            >
              <option value="">
                {t(initializing ? 'device.connectionChecking' : 'device.autoSelection')}
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </ModernSelect>
            {!initializing && !!state?.detection?.unavailablePlatforms.length && (
              <span className="subtle-note">
                {t('device.detectionToolsMissing')}{' '}
                {state.detection.unavailablePlatforms
                  .map(
                    (platformId) =>
                      state.boards.find((platform) => platform.id === platformId)?.name ?? platformId,
                  )
                  .join('、')}
              </span>
            )}
          </label>
        )}
        {!isAuto && usesStlink && (
          <>
            <label>
              <span className="field-label label-with-action">
                <span className="field-label-text">
                  <Usb size={12} strokeWidth={1.8} aria-hidden="true" />
                  {t('device.debugProbe')}
                </span>
                <button
                  className="text-button"
                  onClick={refreshDebugProbes}
                  disabled={!!busy || initializing}
                >
                  <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
                  {t('action.refresh')}
                </button>
              </span>
              <ModernSelect
                value={
                  selectedProbe?.serialNumber ?? (initializing ? config?.programmer?.serialNumber : '') ?? ''
                }
                disabled={!config || !!busy || initializing}
                onChange={(event) => {
                  if (!config) return;
                  setConfig({
                    ...config,
                    programmer: {
                      transport: 'stlink',
                      serialNumber: event.target.value,
                      frequencyKhz: config.programmer?.frequencyKhz ?? 1800,
                    },
                  });
                  setStale(true);
                }}
              >
                <option value="">
                  {t(initializing ? 'device.connectionChecking' : 'device.debugProbePlaceholder')}
                </option>
                {initializing && !selectedProbe && config?.programmer?.serialNumber && (
                  <option value={config.programmer.serialNumber}>
                    {config.programmer.serialNumber} · {t('device.connectionChecking')}
                  </option>
                )}
                {debugProbes.map((probe) => (
                  <option key={probe.serialNumber} value={probe.serialNumber}>
                    {probe.name}
                  </option>
                ))}
              </ModernSelect>
              {initializing ? (
                <span className="subtle-note" role="status">
                  {t('device.connectionChecking')}
                </span>
              ) : !state?.toolchain.stlink ? (
                <span className="subtle-note">{t('device.stlinkToolsMissing')}</span>
              ) : probeUncertain ? (
                <span className="subtle-note">
                  {t(
                    probeState === 'unavailable'
                      ? 'device.connectionCheckUnavailable'
                      : 'device.connectionChecking',
                  )}
                </span>
              ) : !debugProbes.length ? (
                <span className="subtle-note">{t('device.debugProbeMissing')}</span>
              ) : (
                selectedProbe && (
                  <span className="subtle-note">
                    {selectedProbe.chipId
                      ? `${selectedProbe.description ?? 'STM32'} · ${selectedProbe.chipId}${selectedProbe.flashSize ? ` · ${t('memory.flash')} ${selectedProbe.flashSize / 1024} KiB` : ''}`
                      : t('device.debugProbeTargetUnknown')}
                  </span>
                )
              )}
            </label>
            <label>
              <span className="field-label">
                <Gauge size={12} strokeWidth={1.8} aria-hidden="true" />
                {t('device.swdFrequency')}
              </span>
              <input
                type="number"
                min={5}
                max={4000}
                step={1}
                value={config?.programmer?.frequencyKhz ?? 1800}
                disabled={!config || !!busy}
                onChange={(event) => {
                  if (!config) return;
                  setConfig({
                    ...config,
                    programmer: {
                      ...config.programmer,
                      transport: 'stlink',
                      serialNumber: config.programmer?.serialNumber ?? '',
                      frequencyKhz: Number(event.target.value),
                    },
                  });
                  setStale(true);
                }}
              />
            </label>
            {!initializing && !state?.toolchain.stlink && (
              <button className="secondary" onClick={install} disabled={!!busy}>
                {t('action.install')}
              </button>
            )}
          </>
        )}
        {hasSerial &&
          (isAuto || usesStlink ? (
            <details className="device-monitor-options">
              <summary className="subtle-note">{t('device.serialMonitorOptions')}</summary>
              {portField}
            </details>
          ) : (
            portField
          ))}
        {!isAuto && !usesStlink && !pluginTransport && hasSerial && (
          <label>
            <span className="field-label">
              <Gauge size={12} strokeWidth={1.8} aria-hidden="true" />
              {t('device.speed')}
            </span>
            <ModernSelect
              value={config?.baudRate ?? board?.recommendedBaudRate ?? 460800}
              disabled={!config || !!busy}
              onChange={(event) => config && setConfig({ ...config, baudRate: Number(event.target.value) })}
            >
              {(board?.baudRates ?? [115200, 230400, 460800, 921600]).map((value) => (
                <option key={value} value={value}>
                  {value}
                  {value === board?.recommendedBaudRate ? ` · ${t('device.recommended')}` : ''}
                </option>
              ))}
            </ModernSelect>
          </label>
        )}
        <div className="device-actions">
          {(!plugin || plugin.capabilities.includes('probe')) && (
            <button className="secondary" onClick={probe} disabled={!!busy || !canProbe}>
              <ScanSearch size={13} strokeWidth={1.8} aria-hidden="true" />
              {t('action.probe')}
            </button>
          )}
          {configDirty && workspaceOpen && (
            <button className="secondary" onClick={saveConfig} disabled={!!busy}>
              {t('action.apply')}
            </button>
          )}
        </div>
      </section>
      {workspaceOpen ? (
        !hidden.has('layout') && (
          <MemoryUsage state={state} config={config} drafts={drafts} stale={stale || dirty || configDirty} />
        )
      ) : (
        <p className="subtle-note device-empty">{t('welcome.noWorkspace')}</p>
      )}
    </aside>
  );
}
