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
    configDirty,
    saveConfig,
    stale,
    dirty,
    drafts,
  } = studio;
  const workspaceOpen = !!state?.workspaceOpen;
  return (
    <aside className="device-panel">
      <div className="panel-heading">
        <span className="panel-title">
          <CircuitBoard size={14} strokeWidth={1.8} aria-hidden="true" />
          {t('device.title')}
        </span>
        <span className={`status-dot ${config?.port ? '' : 'inactive'}`} />
      </div>
      <section className="inspector-section device-config">
        <label>
          <span className="field-label">
            <Cpu size={12} strokeWidth={1.8} aria-hidden="true" />
            {t('device.board')}
          </span>
          <select
            value={config?.boardId ?? ''}
            disabled={!config || !workspaceOpen || !!busy}
            onChange={(event) => {
              const selected = state?.boards.find((item) => item.id === event.target.value);
              if (config && selected) {
                setConfig({
                  ...config,
                  ...selected.defaultConfig,
                  name: config.name,
                  port: config.port,
                  baudRate:
                    selected.recommendedBaudRate ??
                    selected.defaultConfig.baudRate ??
                    config.baudRate,
                  boardId: selected.id,
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
          {config?.boardId === 'auto' && (
            <span className="subtle-note">{t('device.autoHint')}</span>
          )}
        </label>
        <label>
          <span className="field-label label-with-action">
            <span className="field-label-text">
              <Usb size={12} strokeWidth={1.8} aria-hidden="true" />
              {t('device.port')}
            </span>
            <button className="text-button" onClick={refreshPorts} disabled={!!busy}>
              <RefreshCw size={11} strokeWidth={1.9} aria-hidden="true" />
              {t('action.refresh')}
            </button>
          </span>
          <select
            value={config?.port ?? ''}
            disabled={!config || !workspaceOpen || !!busy}
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
        <label>
          <span className="field-label">
            <Gauge size={12} strokeWidth={1.8} aria-hidden="true" />
            {t('device.speed')}
          </span>
          <select
            value={config?.baudRate ?? board?.recommendedBaudRate ?? 460800}
            disabled={!config || !workspaceOpen || !!busy}
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
        <div className="device-actions">
          <button className="secondary" onClick={probe} disabled={!!busy || !workspaceOpen || !config?.port}>
            <ScanSearch size={13} strokeWidth={1.8} aria-hidden="true" />
            {t('action.probe')}
          </button>
          {configDirty && (
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
