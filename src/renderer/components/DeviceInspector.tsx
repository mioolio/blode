import { CircuitBoard, Cpu, Gauge, RefreshCw, ScanSearch, Usb } from 'lucide-react';
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
  const debugProbes = state?.debugProbes ?? [];
  const selectedProbe = debugProbes.find(
    (probe) => probe.serialNumber.toLowerCase() === config?.programmer?.serialNumber.toLowerCase(),
  );
  const candidates = state?.detection?.candidates ?? [];
  const automaticChoice = isAuto && (!config?.programmer || config.programmer.transport === 'auto');
  const selectedCandidate = candidates.find((candidate) =>
    config?.programmer?.transport === 'stlink'
      ? candidate.transport === 'stlink' &&
        candidate.serialNumber?.toLowerCase() === config.programmer.serialNumber.toLowerCase()
      : config?.programmer?.transport === 'serial' &&
        candidate.transport === 'serial' &&
        candidate.port === config.port,
  );
  const autoDeviceValue = automaticChoice ? '' : (selectedCandidate?.id ?? 'selected-unavailable');
  const canProbe = isAuto || (usesStlink ? !!config?.programmer?.serialNumber : !!config?.port);
  const portField = (
    <label>
      <span className="field-label label-with-action">
        <span className="field-label-text">
          <Usb size={12} strokeWidth={1.8} aria-hidden="true" />
          {t(isAuto || usesStlink ? 'device.serialMonitorPort' : 'device.port')}
        </span>
        <button className="text-button" onClick={refreshPorts} disabled={!!busy}>
          <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
          {t('action.refresh')}
        </button>
      </span>
      <select
        value={config?.port ?? ''}
        disabled={!config || !!busy}
        onChange={(event) => config && setConfig({ ...config, port: event.target.value })}
      >
        <option value="">{t('device.portPlaceholder')}</option>
        {state?.ports.map((port) => (
          <option key={port.path} value={port.path}>
            {port.path}
            {port.manufacturer ? ` — ${port.manufacturer}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <aside className="device-panel">
      <div className="panel-heading">
        <span className="panel-title">
          <CircuitBoard size={14} strokeWidth={1.8} aria-hidden="true" />
          {t('device.title')}
        </span>
        <span
          className={`status-dot ${(isAuto ? selectedCandidate : usesStlink ? selectedProbe : config?.port) ? '' : 'inactive'}`}
        />
      </div>
      <section className="inspector-section device-config">
        <label>
          <span className="field-label">
            <Cpu size={12} strokeWidth={1.8} aria-hidden="true" />
            {t('device.board')}
          </span>
          <select
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
          </select>
          {config?.boardId === 'auto' && <span className="subtle-note">{t('device.autoHint')}</span>}
          {isStm32 && (
            <span className="subtle-note">
              {hasBuildEntry
                ? `${t('project.buildEntry')}: ${state?.build?.entry ?? state?.build?.sketch}`
                : t('device.stm32EntryHint')}
            </span>
          )}
        </label>
        {isAuto && (
          <label>
            <span className="field-label label-with-action">
              <span className="field-label-text">
                <Usb size={12} strokeWidth={1.8} aria-hidden="true" />
                {t('device.detectDevice')}
              </span>
              <button className="text-button" onClick={refreshAutoDevices} disabled={!!busy}>
                <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
                {t('action.refresh')}
              </button>
            </span>
            <select
              value={autoDeviceValue}
              disabled={!config || !!busy}
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
                });
                setStale(true);
              }}
            >
              <option value="">{t('device.autoSelection')}</option>
              {!automaticChoice && !selectedCandidate && (
                <option value="selected-unavailable">
                  {usesStlink ? `ST-Link ${config?.programmer?.serialNumber ?? ''}` : config?.port}
                  {' · '}
                  {t('device.debugProbeUnavailable')}
                </option>
              )}
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <span className="subtle-note">{t('device.autoDeviceHint')}</span>
            {!!state?.detection?.unavailablePlatforms.length && (
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
                <button className="text-button" onClick={refreshDebugProbes} disabled={!!busy}>
                  <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
                  {t('action.refresh')}
                </button>
              </span>
              <select
                value={selectedProbe?.serialNumber ?? config?.programmer?.serialNumber ?? ''}
                disabled={!config || !!busy}
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
                <option value="">{t('device.debugProbePlaceholder')}</option>
                {config?.programmer?.serialNumber && !selectedProbe && (
                  <option value={config.programmer.serialNumber}>
                    {config.programmer.serialNumber} · {t('device.debugProbeUnavailable')}
                  </option>
                )}
                {debugProbes.map((probe) => (
                  <option key={probe.serialNumber} value={probe.serialNumber}>
                    {probe.name}
                  </option>
                ))}
              </select>
              {!state?.toolchain.stlink ? (
                <span className="subtle-note">{t('device.stlinkToolsMissing')}</span>
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
            {!state?.toolchain.stlink && (
              <button className="secondary" onClick={install} disabled={!!busy}>
                {t('action.install')}
              </button>
            )}
          </>
        )}
        {isAuto || usesStlink ? (
          <details className="device-monitor-options">
            <summary className="subtle-note">{t('device.serialMonitorOptions')}</summary>
            {portField}
          </details>
        ) : (
          portField
        )}
        {!isAuto && !usesStlink && (
          <label>
            <span className="field-label">
              <Gauge size={12} strokeWidth={1.8} aria-hidden="true" />
              {t('device.speed')}
            </span>
            <select
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
            </select>
          </label>
        )}
        <div className="device-actions">
          <button className="secondary" onClick={probe} disabled={!!busy || !canProbe}>
            <ScanSearch size={13} strokeWidth={1.8} aria-hidden="true" />
            {t('action.probe')}
          </button>
          {configDirty && workspaceOpen && (
            <button className="secondary" onClick={saveConfig} disabled={!!busy}>
              {t('action.apply')}
            </button>
          )}
        </div>
      </section>
      {workspaceOpen ? (
        <MemoryUsage state={state} config={config} drafts={drafts} stale={stale || dirty || configDirty} />
      ) : (
        <p className="subtle-note device-empty">{t('welcome.noWorkspace')}</p>
      )}
    </aside>
  );
}
