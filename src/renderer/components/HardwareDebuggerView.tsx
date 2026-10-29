import { ModernSelect } from './ModernSelect';
import { RuntimePluginView } from './RuntimePluginView';
import { RuntimePluginTrustDialog } from './RuntimePluginTrustDialog';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Braces,
  Cpu,
  Database,
  FileCode2,
  Layers3,
  ListTree,
  MemoryStick,
  RefreshCw,
  Terminal,
  Minus,
  Square,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';
import type {
  AppState,
  DebuggerState,
  DebuggerAction,
  DebuggerStorage,
  ProjectConfig,
  InstallationState,
} from '../../shared/contracts';
import { InstallationOutput } from './InstallationOutput';
import './hardware-debugger.css';

type DebugView = 'overview' | 'cpu' | 'memory' | 'storage' | 'log';
const numberOf = (value: string | undefined) => (value ? Number.parseInt(value, 0) : NaN);
const hexAddress = (value: number) => `0x${value.toString(16).padStart(8, '0')}`;
const bytesLabel = (value: number) => (value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`);
const commandKeys: DebuggerAction[] = ['continue', 'pause', 'step', 'next', 'finish'];

/** Independent native debugging surface. Sampled hardware data and local file data stay separate. */
export function HardwareDebuggerView() {
  const customTitlebar = window.__blodeFrameless === true;
  const isWeb = window.__blodeWeb === true;
  const { t, locale } = useI18n();
  const [debug, setDebug] = useState<DebuggerState | null>(null);
  const debugRef = useRef<DebuggerState | null>(null);
  const [app, setApp] = useState<AppState | null>(null);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [paneWidth, setPaneWidth] = useState(64);
  const [view, setView] = useState<DebugView>('overview');
  const [storage, setStorage] = useState<DebuggerStorage | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installation, setInstallation] = useState<InstallationState>();
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [location, setLocation] = useState('main');
  const [address, setAddress] = useState('0x20000000');
  const [length, setLength] = useState(128);
  const [memory, setMemory] = useState<{ contents: string; address: number; time: string } | null>(null);
  const [changedRegisters, setChangedRegisters] = useState<Set<string>>(new Set());
  const lastRegisters = useRef(new Map<string, string>());
  const lastSample = useRef<string | undefined>(undefined);
  const connected = debug?.connection === 'stopped' || debug?.connection === 'running';
  const stopped = debug?.connection === 'stopped';
  const attaching = debug?.connection === 'connecting';
  const record = new Map(
    (debug?.registers ?? []).map((register) => [register.name.toLowerCase(), register.value]),
  );
  const register = (name: string) =>
    record.get(name) ??
    record.get(name === 'pc' ? 'r15' : name === 'sp' ? 'r13' : name === 'lr' ? 'r14' : name) ??
    '—';
  const pc = debug?.programCounter || register('pc');
  const psr = numberOf(record.get('xpsr') ?? record.get('cpsr'));
  const timestamp = (value?: string) =>
    value && !Number.isNaN(Date.parse(value))
      ? new Date(value).toLocaleTimeString(locale, { hour12: false })
      : '—';
  const sampleTime = timestamp(debug?.updatedAt);
  const serial = config?.programmer?.serialNumber ?? '';
  const probes = app?.debugProbes ?? [];
  const serialAvailable = probes.some((probe) => probe.serialNumber === serial);
  const selectedSerial = serialAvailable || connected ? serial : '';
  const selectedRuntime = app?.boards.find((board) => board.id === config?.boardId);
  const plugin = selectedRuntime?.runtimePlugin;
  const pluginDebugger = plugin?.debugger.mode === 'extend' || plugin?.debugger.mode === 'replace';
  const nativeDebugger = config?.boardId === 'STM32F103C8T6' || plugin?.debugger.mode === 'builtin';
  const debugSupported = nativeDebugger || pluginDebugger;
  const tabs = [
    { id: 'overview' as const, icon: Activity },
    { id: 'cpu' as const, icon: Cpu },
    { id: 'memory' as const, icon: MemoryStick },
    { id: 'storage' as const, icon: Database },
    { id: 'log' as const, icon: Terminal },
  ];

  const updateDebug = (next: DebuggerState) => {
    debugRef.current = next;
    if (next.updatedAt && next.updatedAt !== lastSample.current) {
      const previous = lastRegisters.current;
      setChangedRegisters(
        new Set(
          next.registers
            .filter((item) => previous.has(item.name) && previous.get(item.name) !== item.value)
            .map((item) => item.name),
        ),
      );
      lastRegisters.current = new Map(next.registers.map((item) => [item.name, item.value]));
      lastSample.current = next.updatedAt;
    }
    setDebug(next);
  };
  const refresh = async () => updateDebug(await window.blode.debuggerState());
  const devices = async () => {
    const state = await window.blode.getState();
    setApp(state);
    setInstallation((current) =>
      current && (!state.installation || current.updatedAt > state.installation.updatedAt)
        ? current
        : state.installation,
    );
    setConfig((current) => {
      if (debugRef.current && ['running', 'stopped', 'connecting'].includes(debugRef.current.connection))
        return current;
      const target =
        state.config.boardId !== 'auto'
          ? state.config
          : (state.boards.find((board) => board.id === 'STM32F103C8T6')?.defaultConfig as ProjectConfig);
      const next =
        current?.boardId === target?.boardId ? { ...target, programmer: current.programmer } : target;
      if (!next) return null;
      if (
        state.connections?.probes.state === 'ready' &&
        next.programmer?.serialNumber &&
        !state.debugProbes.some((probe) => probe.serialNumber === next.programmer?.serialNumber)
      )
        return { ...next, programmer: { ...next.programmer, serialNumber: '' } };
      return next;
    });
  };
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const unsubscribe = window.blode.onEvent((event) => {
      if (disposed) return;
      if (event.installation)
        setInstallation((current) => ({
          ...event.installation!,
          logs: event.progressOnly
            ? current?.id === event.installation!.id
              ? current.logs
              : []
            : [...(current?.id === event.installation!.id ? current.logs.slice(-299) : []), event],
        }));
      if (
        [
          'status.devicesChanged',
          'status.configSaved',
          'status.projectOpened',
          'status.projectClosed',
        ].includes(event.message)
      )
        void devices().catch((e) => setError(String(e)));
    });
    void devices().catch((e) => setError(String(e)));
    void window.blode
      .debuggerStorage()
      .then((next) => {
        if (!disposed) setStorage(next);
      })
      .catch((e) => setError(String(e)));
    const tick = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await window.blode.debuggerState();
        if (!disposed) updateDebug(next);
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        pending = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const act = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const command = (action: DebuggerAction) => void act(() => window.blode.debuggerAction(action));
  const chooseSymbols = () =>
    void act(async () => {
      const chosen = await window.blode.debuggerSymbols();
      if (chosen) setStorage(await window.blode.debuggerStorage());
    });
  const readMemory = () =>
    void act(async () => {
      const start = Number(address);
      const contents = await window.blode.debuggerMemory(start, length);
      setMemory({ contents, address: start, time: new Date().toISOString() });
    });
  const hexdump = (contents: string, start: number) =>
    (contents.match(/.{1,32}/g) ?? [])
      .map((line, index) => {
        const bytes = line.match(/../g) ?? [];
        const ascii = bytes
          .map((byte) => {
            const code = Number.parseInt(byte, 16);
            return code >= 32 && code <= 126 ? String.fromCharCode(code) : '.';
          })
          .join('');
        return `${hexAddress(start + index * 16)}  ${bytes.join(' ').padEnd(47)}  ${ascii}`;
      })
      .join('\n');
  const coreRegisterNames = [...Array.from({ length: 13 }, (_, index) => `r${index}`), 'sp', 'lr', 'pc'];
  const emptyHardware = (
    <div className="debug-empty">
      <Cpu size={28} strokeWidth={1.3} />
      <p>{t('debugger.dashboard.noHardwareSample')}</p>
    </div>
  );

  const stackPanel = (
    <section className="debug-card debug-stack">
      <h2>
        <Layers3 size={15} />
        {t('debugger.stack')}
      </h2>
      {debug?.stack.length ? (
        <div className="debug-scroll">
          {debug.stack.map((frame) => (
            <div className="debug-frame" key={frame.level}>
              <strong>
                #{frame.level} {frame.function}
              </strong>
              <code>{frame.address}</code>
              <span>
                {frame.file}
                {frame.line ? ':' + frame.line : ''}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="debug-muted">{t('debugger.dashboard.stackEmpty')}</p>
      )}
    </section>
  );
  const breakpointsPanel = (
    <section className="debug-card debug-breakpoints">
      <h2>
        <ListTree size={15} />
        {t('debugger.breakpoints')}
      </h2>
      <div className="debug-inline">
        <input
          aria-label={t('debugger.breakpoints')}
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="main / main.c:20 / *0x08000100"
        />
        <button
          disabled={!stopped || busy}
          onClick={() => void act(() => window.blode.debuggerBreakpoint(location))}
        >
          {t('debugger.add')}
        </button>
      </div>
      {debug?.breakpoints.map((point) => (
        <div className="debug-inline" key={point.id}>
          <code>
            #{point.id} {point.location}
          </code>
          <button
            disabled={!stopped || busy}
            onClick={() => void act(() => window.blode.debuggerBreakpoint('', point.id))}
          >
            {t('action.deleteEntry')}
          </button>
        </div>
      ))}
      {!debug?.breakpoints.length && (
        <p className="debug-muted">{t('debugger.dashboard.breakpointsEmpty')}</p>
      )}
    </section>
  );
  const instructionPanel = (
    <section className="debug-card debug-instructions">
      <h2>
        <FileCode2 size={15} />
        {t('debugger.dashboard.instructions')}
        <code>{pc}</code>
      </h2>
      {debug?.instructions?.length ? (
        <div className="debug-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('debugger.address')}</th>
                <th>{t('debugger.dashboard.function')}</th>
                <th>{t('debugger.dashboard.instruction')}</th>
              </tr>
            </thead>
            <tbody>
              {debug.instructions.map((item, index) => (
                <tr
                  key={`${item.address}-${index}`}
                  className={numberOf(item.address) === numberOf(pc) ? 'is-current-instruction' : ''}
                >
                  <td>
                    {numberOf(item.address) === numberOf(pc) ? '▶ ' : ''}
                    {item.address}
                  </td>
                  <td>
                    {item.function}
                    {item.offset ? ` +${item.offset}` : ''}
                  </td>
                  <td>{item.instruction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="debug-muted">{t('debugger.dashboard.instructionEmpty')}</p>
      )}
    </section>
  );

  const registerPanel = (
    <section className="debug-card debug-registers">
      <h2>
        <Cpu size={15} />
        {t('debugger.registers')}
      </h2>
      {debug?.registers.length ? (
        <div className="debug-register-bank">
          {coreRegisterNames.map((name) => (
            <div
              key={name}
              className={`debug-register ${name === 'pc' ? 'register-pc' : ''} ${changedRegisters.has(name) ? 'register-changed' : ''}`}
            >
              <span>{name.toUpperCase()}</span>
              <code>{register(name)}</code>
            </div>
          ))}
        </div>
      ) : (
        emptyHardware
      )}
      <div className="debug-flags">
        <span>xPSR</span>
        <code>{record.get('xpsr') ?? record.get('cpsr') ?? '—'}</code>
        {[
          ['N', 31],
          ['Z', 30],
          ['C', 29],
          ['V', 28],
          ['T', 24],
        ].map(([label, bit]) => (
          <span className="debug-flag" key={label}>
            {label}
            <b>{Number.isFinite(psr) ? (psr >>> Number(bit)) & 1 : '—'}</b>
          </span>
        ))}
      </div>
    </section>
  );
  const memoryPanel = (
    <section className="debug-card debug-memory-view">
      <h2>
        <MemoryStick size={15} />
        {t('debugger.memory')}
        <span className="debug-data-source">{t('debugger.dashboard.sourceHardware')}</span>
      </h2>
      <div className="debug-memory-presets">
        <button onClick={() => setAddress('0x20000000')}>SRAM · 0x20000000</button>
        <button onClick={() => setAddress('0x08000000')}>Flash · 0x08000000</button>
        <button
          onClick={() =>
            Number.isFinite(numberOf(register('sp'))) && setAddress(hexAddress(numberOf(register('sp'))))
          }
          disabled={!Number.isFinite(numberOf(register('sp')))}
        >
          {t('debugger.dashboard.atSp')}
        </button>
        <button
          onClick={() => Number.isFinite(numberOf(pc)) && setAddress(hexAddress(numberOf(pc)))}
          disabled={!Number.isFinite(numberOf(pc))}
        >
          {t('debugger.dashboard.atPc')}
        </button>
      </div>
      <div className="debug-inline">
        <label>
          {t('debugger.address')}
          <input value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <label>
          {t('debugger.length')}
          <input
            type="number"
            min={1}
            max={4096}
            value={length}
            onChange={(event) => setLength(Number(event.target.value))}
          />
        </label>
        <button
          disabled={
            !stopped ||
            busy ||
            !Number.isSafeInteger(Number(address)) ||
            Number(address) < 0 ||
            !Number.isInteger(length) ||
            length < 1 ||
            length > 4096
          }
          onClick={readMemory}
        >
          {t('debugger.read')}
        </button>
      </div>
      {memory ? (
        <>
          <div className="debug-memory-caption">
            {hexAddress(memory.address)} · {memory.contents.length / 2} B · {timestamp(memory.time)}
          </div>
          <pre className="debug-hexdump">{hexdump(memory.contents, memory.address)}</pre>
        </>
      ) : (
        <div className="debug-empty">
          <MemoryStick size={30} strokeWidth={1.3} />
          <p>{t('debugger.dashboard.memoryEmpty')}</p>
        </div>
      )}
    </section>
  );

  return (
    <>
      <RuntimePluginTrustDialog id={config?.boardId} />
      {customTitlebar && (
        <header className="topbar debug-titlebar">
          <span className="brand-name">Blode Studio</span>
          <span className="topbar-spacer" aria-hidden="true" />
          <div className="window-controls">
            <button
              aria-label={t('window.minimize')}
              title={t('window.minimize')}
              onClick={() => window.blode.windowAction('minimize')}
            >
              <Minus size={14} strokeWidth={2} />
            </button>
            <button
              aria-label={t('window.maximize')}
              title={t('window.maximize')}
              onClick={() => window.blode.windowAction('maximize')}
            >
              <Square size={11} strokeWidth={2} />
            </button>
            <button
              className="window-close"
              aria-label={t('window.close')}
              title={t('window.close')}
              onClick={() => window.blode.windowAction('close')}
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </header>
      )}
      <div className={`hardware-debugger${customTitlebar ? ' debug-has-titlebar' : ''}`}>
        <header className="debug-page-heading">
          <div className="debug-brand">
            <div>
              <h1>{t('debugger.dashboard.title')}</h1>
              <p>
                {selectedRuntime?.name ?? t(isWeb ? 'debugger.webSubtitle' : 'debugger.dashboard.subtitle')}
              </p>
            </div>
          </div>
          <span className={`debug-state state-${debug?.connection ?? 'disconnected'}`}>
            {t(`debugger.state.${debug?.connection ?? 'disconnected'}`)}
          </span>
        </header>
        <section className="debug-connection-bar">
          {pluginDebugger ? (
            <label>
              <span>{t('runtime.deviceId')}</span>
              <input
                value={config?.runtime?.deviceId ?? ''}
                disabled={connected || attaching || busy}
                onChange={(event) =>
                  setConfig((current) =>
                    current
                      ? { ...current, runtime: { ...current.runtime, deviceId: event.target.value } }
                      : current,
                  )
                }
              />
            </label>
          ) : (
            nativeDebugger && (
              <>
                <label>
                  <span>ST-Link / SWD</span>
                  <ModernSelect
                    value={selectedSerial}
                    disabled={connected || attaching || busy}
                    onChange={(event) =>
                      setConfig((current) =>
                        current
                          ? {
                              ...current,
                              programmer: {
                                transport: 'stlink',
                                serialNumber: event.target.value,
                                frequencyKhz: current.programmer?.frequencyKhz ?? 1800,
                              },
                            }
                          : current,
                      )
                    }
                  >
                    <option value="">{t('error.selectDebugProbe')}</option>
                    {probes.map((probe) => (
                      <option key={probe.serialNumber} value={probe.serialNumber}>
                        {probe.description ?? 'ST-Link'} · {probe.serialNumber}
                      </option>
                    ))}
                  </ModernSelect>
                </label>
              </>
            )
          )}
          {nativeDebugger && (
            <>
              <button
                disabled={connected || attaching || busy}
                onClick={() =>
                  void act(async () => {
                    await window.blode.listDebugProbes();
                    await devices();
                  })
                }
              >
                <RefreshCw size={13} />
                {t('action.refresh')}
              </button>
              <label className="debug-frequency">
                <span>{t('debugger.dashboard.frequency')}</span>
                <input
                  aria-label={t('debugger.dashboard.frequency')}
                  type="number"
                  min={5}
                  max={4000}
                  disabled={connected || attaching || busy}
                  value={config?.programmer?.frequencyKhz ?? 1800}
                  onChange={(event) =>
                    setConfig((current) =>
                      current
                        ? {
                            ...current,
                            programmer: {
                              transport: 'stlink',
                              serialNumber: current.programmer?.serialNumber ?? '',
                              frequencyKhz: Number(event.target.value),
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
            </>
          )}
          <button
            className="primary"
            disabled={
              connected ||
              attaching ||
              busy ||
              !debugSupported ||
              (!pluginDebugger && (!selectedSerial || !debug?.tools.gdb || !debug?.tools.server))
            }
            onClick={() => config && void act(() => window.blode.debuggerConnect(config))}
          >
            {t('debugger.connect')}
          </button>
          <button disabled={(!connected && !attaching) || busy} onClick={() => command('disconnect')}>
            {t('debugger.disconnect')}
          </button>
        </section>
        {!debugSupported && config && (
          <div className="debug-runtime-status">{t('debugger.runtimeUnsupported')}</div>
        )}
        {nativeDebugger && (!debug?.tools.gdb || !debug?.tools.server) && (
          <section className="debug-tools-note">
            <span>
              {t('debugger.toolsMissing')} GDB: {debug?.tools.gdb ? '✓' : '—'} · st-util:{' '}
              {debug?.tools.server ? '✓' : '—'}
            </span>
            <button
              disabled={busy || connected || attaching}
              onClick={() =>
                void act(async () => {
                  setInstalling(true);
                  try {
                    await window.blode.debuggerInstallTools();
                  } finally {
                    setInstalling(false);
                  }
                })
              }
            >
              {t('debugger.installTools')}
            </button>
            {!isWeb && (
              <button
                disabled={busy || connected || attaching}
                onClick={() => void act(() => window.blode.debuggerChooseGdb())}
              >
                {t('debugger.chooseGdb')}
              </button>
            )}
          </section>
        )}
        {(installation || installing) && (
          <InstallationOutput installation={installation} pending={installing} />
        )}
        {(error || debug?.message) && (
          <div className="debug-error" role="alert">
            {t(error || debug?.message || '')}
          </div>
        )}
        <div className="debug-workbench-bar">
          <nav role="tablist" aria-label={t('debugger.dashboard.title')}>
            {tabs.map(({ id, icon: Icon }) => (
              <button
                role="tab"
                aria-selected={view === id}
                aria-controls={`debug-panel-${id}`}
                id={`debug-tab-${id}`}
                className={view === id ? 'active' : ''}
                key={id}
                onClick={() => setView(id)}
              >
                <Icon size={15} />
                {t(`debugger.dashboard.tab.${id}`)}
              </button>
            ))}
          </nav>
          <span className="debug-sample-stamp">
            {t(
              debug?.connection === 'running'
                ? 'debugger.dashboard.lastPausedSample'
                : 'debugger.dashboard.sampleTime',
            )}
            : {sampleTime}
          </span>
        </div>
        <div className="debug-execution-toolbar">
          {commandKeys.map((action) => (
            <button
              key={action}
              disabled={busy || (action === 'pause' ? debug?.connection !== 'running' : !stopped)}
              onClick={() => command(action)}
            >
              {t(`debugger.${action}`)}
            </button>
          ))}
        </div>
        <main
          className="debug-page-content"
          role="tabpanel"
          id={`debug-panel-${view}`}
          aria-labelledby={`debug-tab-${view}`}
        >
          {plugin?.debugger.view && (
            <section className="debug-card debug-plugin-view">
              <RuntimePluginView id={plugin.id} kind="debugger" />
            </section>
          )}
          {!(plugin?.debugger.mode === 'replace' && plugin.debugger.view) && (
            <>
              {view === 'overview' && (
                <>
                  <div className="debug-summary-grid">
                    <div className="debug-summary">
                      <span>{t('debugger.dashboard.programCounter')}</span>
                      <strong>{pc}</strong>
                    </div>
                    <div className="debug-summary">
                      <span>{t('debugger.dashboard.stackPointer')}</span>
                      <strong>{register('sp')}</strong>
                    </div>
                    <div className="debug-summary">
                      <span>{t('debugger.dashboard.symbolFile')}</span>
                      <strong className="file-value">{debug?.symbols || t('debugger.noSymbols')}</strong>
                    </div>
                    <div className="debug-summary">
                      <span>{t('debugger.dashboard.target')}</span>
                      <strong>
                        {probes.find((probe) => probe.serialNumber === selectedSerial)?.description ||
                          'STM32 / Cortex-M'}
                      </strong>
                    </div>
                  </div>
                  <div
                    className="debug-dock-grid"
                    style={{
                      gridTemplateColumns: `minmax(320px, ${paneWidth}fr) 6px minmax(260px, ${100 - paneWidth}fr)`,
                    }}
                  >
                    <div className="debug-main-stack">
                      {instructionPanel}
                      {memoryPanel}
                    </div>
                    <div
                      className="debug-pane-divider"
                      role="separator"
                      aria-label={t('debugger.resizePanes')}
                      aria-orientation="vertical"
                      aria-valuemin={35}
                      aria-valuemax={75}
                      aria-valuenow={paneWidth}
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                          event.preventDefault();
                          setPaneWidth((value) =>
                            Math.max(35, Math.min(75, value + (event.key === 'ArrowRight' ? 2 : -2))),
                          );
                        }
                      }}
                      onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        event.currentTarget.dataset.dragging = 'true';
                      }}
                      onPointerUp={(event) => {
                        delete event.currentTarget.dataset.dragging;
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }}
                      onPointerCancel={(event) => {
                        delete event.currentTarget.dataset.dragging;
                      }}
                      onPointerMove={(event) => {
                        if (!event.currentTarget.dataset.dragging) return;
                        const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
                        setPaneWidth(
                          Math.round(
                            Math.max(35, Math.min(75, ((event.clientX - bounds.left) / bounds.width) * 100)),
                          ),
                        );
                      }}
                    />
                    <div className="debug-side-stack">
                      {registerPanel}
                      {stackPanel}
                      {breakpointsPanel}
                    </div>
                  </div>
                </>
              )}
              {view === 'cpu' && (
                <>
                  {registerPanel}
                  {instructionPanel}
                  <div className="debug-two-columns">
                    {stackPanel}
                    {breakpointsPanel}
                  </div>
                  <section className="debug-card">
                    <h2>
                      <Braces size={15} />
                      {t('debugger.dashboard.allRegisters')}
                    </h2>
                    <div className="debug-scroll">
                      <table>
                        <tbody>
                          {debug?.registers.map((item) => (
                            <tr
                              key={item.name}
                              className={changedRegisters.has(item.name) ? 'register-changed' : ''}
                            >
                              <th>{item.name}</th>
                              <td>{item.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </>
              )}
              {view === 'memory' && memoryPanel}
              {view === 'storage' && (
                <>
                  <section className="debug-card">
                    <h2>
                      <Database size={15} />
                      {t('debugger.dashboard.firmwareStorage')}
                      <span className="debug-data-source source-file">
                        {t('debugger.dashboard.sourceFile')}
                      </span>
                    </h2>
                    <p className="debug-muted">{t('debugger.dashboard.storageNote')}</p>
                    <div className="debug-inline">
                      <button disabled={connected || attaching || busy} onClick={chooseSymbols}>
                        {t('debugger.symbols')}
                      </button>
                      <span>{debug?.symbols || t('debugger.noSymbols')}</span>
                    </div>
                    {storage ? (
                      <>
                        <div className="debug-file-summary">
                          <FileCode2 size={24} />
                          <strong>{storage.name}</strong>
                          <span>{bytesLabel(storage.size)}</span>
                          <span>ARM ELF</span>
                        </div>
                        <div className="debug-storage-segments">
                          {storage.segments.map((segment, index) => (
                            <div
                              key={`${segment.address}-${index}`}
                              className={`debug-storage-segment storage-${segment.kind}`}
                            >
                              <span>{segment.kind.toUpperCase()}</span>
                              <code>
                                {hexAddress(segment.address)} –{' '}
                                {hexAddress(segment.address + Math.max(0, segment.size - 1))}
                              </code>
                              <strong>{bytesLabel(segment.size)}</strong>
                            </div>
                          ))}
                        </div>
                        <h3>{t('debugger.dashboard.filePreview')}</h3>
                        <pre className="debug-hexdump">{hexdump(storage.preview, 0)}</pre>
                      </>
                    ) : (
                      <div className="debug-empty">
                        <Database size={30} strokeWidth={1.3} />
                        <p>{t('debugger.dashboard.storageEmpty')}</p>
                      </div>
                    )}
                  </section>
                </>
              )}
              {view === 'log' && (
                <section className="debug-card">
                  <h2>
                    <Terminal size={15} />
                    {t('debugger.log')}
                  </h2>
                  <pre className="debug-log-view">
                    {debug?.log.join('\n') || t('debugger.dashboard.logEmpty')}
                  </pre>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}
