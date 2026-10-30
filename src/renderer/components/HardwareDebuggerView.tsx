import { ModernSelect } from './ModernSelect';
import { RuntimePluginView } from './RuntimePluginView';
import { RuntimePluginTrustDialog } from './RuntimePluginTrustDialog';
import { DebuggerDialog, DebuggerMenubar, type DebuggerMenu } from './DebuggerChrome';
import {
  breakpointLocations,
  canPatchInstruction,
  machineCodeBytes,
  validMemoryRange,
  instructionAssembly,
} from './debuggerEditing';
import { DebuggerRequests } from './debuggerRequests';
import { debuggerPresentation, debuggerRegister, debuggerToolIdentity } from './debuggerProfiles';
import { DebuggerToolsPanel } from './DebuggerToolsPanel';
import { DebuggerErrorNotice } from './DebuggerErrorNotice';
import { debuggerDiagnosticLog } from '../../shared/debugger-errors';
import { getDebuggerProfile } from '../../shared/debugger-profiles';
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
  Pencil,
  Plus,
  Play,
  Pause,
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

/** Shared desktop/browser debugging workbench. */
export function HardwareDebuggerView() {
  const customTitlebar = window.__blodeFrameless === true;
  const isWeb = window.__blodeWeb === true;
  const { t, locale } = useI18n();
  const [debug, setDebug] = useState<DebuggerState | null>(null);
  const debugRef = useRef<DebuggerState | null>(null);
  const requests = useRef(new DebuggerRequests());
  const [app, setApp] = useState<AppState | null>(null);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const configRef = useRef<ProjectConfig | null>(null);
  configRef.current = config;
  const [paneWidth, setPaneWidth] = useState(64);
  const [view, setView] = useState<DebugView>('overview');
  const [storage, setStorage] = useState<DebuggerStorage | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installation, setInstallation] = useState<InstallationState>();
  const installationOwner = useRef<{ requested: boolean; id?: string }>({ requested: false });
  const [checkedTools, setCheckedTools] = useState<{ identity: string; tools: DebuggerState['tools'] }>();
  const checkedToolsRef = useRef<typeof checkedTools>(undefined);
  const [checkingTools, setCheckingTools] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [localFailures, setLocalFailures] = useState<string[]>([]);
  const [location, setLocation] = useState('main');
  const [dialog, setDialog] = useState<'connection' | 'tools' | 'breakpoints' | null>(null);
  const [batchText, setBatchText] = useState('');
  const [batchResults, setBatchResults] = useState<
    Awaited<ReturnType<typeof window.blode.debuggerBreakpoints>>
  >([]);
  const [patch, setPatch] = useState<NonNullable<DebuggerState['instructions']>[number] | null>(null);
  const [patchBytes, setPatchBytes] = useState('');
  const [patchSession, setPatchSession] = useState('');
  const [patchMode, setPatchMode] = useState<'hex' | 'assembly'>('hex');
  const [assembly, setAssembly] = useState('');
  const [assembled, setAssembled] = useState(false);
  const [patchResume, setPatchResume] = useState(false);
  const [patchResult, setPatchResult] = useState('');
  const [address, setAddress] = useState('0x20000000');
  const [length, setLength] = useState(128);
  const [memory, setMemory] = useState<{ contents: string; address: number; time: string } | null>(null);
  const [changedRegisters, setChangedRegisters] = useState<Set<string>>(new Set());
  const lastRegisters = useRef(new Map<string, string>());
  const lastSample = useRef<string | undefined>(undefined);
  const connected = debug?.connection === 'stopped' || debug?.connection === 'running';
  const stopped = debug?.connection === 'stopped';
  const attaching = debug?.connection === 'connecting';
  const selectedRuntime = app?.boards.find((board) => board.id === config?.boardId);
  const plugin = selectedRuntime?.runtimePlugin;
  const profile = debuggerPresentation(
    (connected || attaching ? debug?.profile?.id : undefined) ?? config?.boardId,
    plugin?.compiler.baseRuntime,
  );
  const usbJtag = profile?.id === 'Esp32_S3_CAM';
  const record = new Map(
    (debug?.registers ?? []).map((register) => [register.name.toLowerCase(), register.value]),
  );
  const register = (name: string) => debuggerRegister(record, name, profile);
  const pc = debug?.programCounter || register('pc');
  const psr = profile?.statusRegister ? numberOf(register(profile.statusRegister)) : NaN;
  const timestamp = (value?: string) =>
    value && !Number.isNaN(Date.parse(value))
      ? new Date(value).toLocaleTimeString(locale, { hour12: false })
      : '—';
  const sampleTime = timestamp(debug?.updatedAt);
  const serial = config?.programmer?.serialNumber ?? '';
  const probes = app?.debugProbes ?? [];
  const serialAvailable = probes.some((probe) => probe.serialNumber === serial);
  const selectedSerial = serialAvailable || connected ? serial : '';
  const customOnly = plugin?.debugger.mode === 'replace' && !!plugin.debugger.view;
  const pluginDebugger = plugin?.debugger.mode === 'extend' || plugin?.debugger.mode === 'replace';
  const nativeDebugger = !!profile || plugin?.debugger.mode === 'builtin';
  const patchSupported = !!profile?.patch && debug?.profile?.canPatchInstructions !== false;
  const frequency = profile?.frequency ?? { default: 1800, min: 5, max: 4000 };
  const registeredProfile = profile ? getDebuggerProfile(profile.id) : undefined;
  const toolIdentity = debuggerToolIdentity(config);
  const currentTools = checkedTools?.identity === toolIdentity ? checkedTools.tools : undefined;
  const toolsLocked = busy || connected || attaching || !config;
  const debugSupported = nativeDebugger || pluginDebugger;
  const builtinPanels = !customOnly && (!config || debugSupported);
  const statusMessage = busy
    ? ''
    : error ||
      (!customOnly && !(debug?.message === 'error.runtimeDebuggerUnsupported' && !debugSupported)
        ? debug?.message
        : '');
  const diagnosticLog = debuggerDiagnosticLog(debug?.log ?? [], [...localFailures, debug?.message ?? '']);
  const reportError = (value: unknown) => {
    const message = value instanceof Error ? value.message : String(value);
    setError(message);
    setLocalFailures((current) => (current.at(-1) === message ? current : [...current.slice(-15), message]));
  };
  const showLog = () => {
    setDialog(null);
    setPatch(null);
    setView('log');
  };
  const errorNotice = statusMessage ? (
    <DebuggerErrorNotice
      message={statusMessage}
      transport={usbJtag ? 'usb-jtag' : 'swd'}
      onViewLog={showLog}
    />
  ) : null;
  const tabs = [
    { id: 'overview' as const, icon: Activity },
    { id: 'cpu' as const, icon: Cpu },
    { id: 'memory' as const, icon: MemoryStick },
    { id: 'storage' as const, icon: Database },
    { id: 'log' as const, icon: Terminal },
  ];

  const updateDebug = (next: DebuggerState) => {
    const active = next.connection === 'running' || next.connection === 'stopped';
    const sessionChanged = next.sessionId !== debugRef.current?.sessionId;
    if (!active || sessionChanged) {
      setMemory(null);
      setPatch(null);
      setChangedRegisters(new Set());
      lastRegisters.current.clear();
      lastSample.current = undefined;
    }
    debugRef.current = next;
    if (active && next.updatedAt && next.updatedAt !== lastSample.current) {
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
  const targetIdentity = `${config?.boardId ?? ''}:${config?.programmer?.serialNumber ?? ''}:${config?.runtime?.deviceId ?? ''}`;
  useEffect(() => {
    requests.current.invalidate();
    let disposed = false;
    setMemory(null);
    setAddress(hexAddress(profile?.defaultMemory ?? 0x20000000));
    setChangedRegisters(new Set());
    lastRegisters.current.clear();
    lastSample.current = undefined;
    setPatch(null);
    setBatchResults([]);
    setStorage(null);
    setCheckedTools(undefined);
    checkedToolsRef.current = undefined;
    setCheckingTools(null);
    setInstallation(undefined);
    setError('');
    setLocalFailures([]);
    installationOwner.current = { requested: false };
    void requests.current
      .read('storage', async () => {
        await window.blode.debuggerState(configRef.current ?? undefined);
        return window.blode.debuggerStorage();
      })
      .then((result) => {
        if (!disposed && result && requests.current.current(result.token)) setStorage(result.value);
      })
      .catch((e) => {
        if (!disposed) reportError(e);
      });
    return () => {
      disposed = true;
    };
  }, [targetIdentity]);
  const refresh = async (showChecking = false) => {
    const selection = configRef.current ?? undefined;
    const identity = debuggerToolIdentity(selection);
    const token = requests.current.begin('state');
    if (showChecking || checkedToolsRef.current?.identity !== identity) setCheckingTools(identity);
    try {
      const next = await window.blode.debuggerState(selection);
      if (!requests.current.current(token) || identity !== debuggerToolIdentity(configRef.current))
        return null;
      const checked = { identity, tools: next.tools };
      checkedToolsRef.current = checked;
      setCheckedTools(checked);
      updateDebug(next);
      return next;
    } catch (e) {
      if (requests.current.current(token)) throw e;
      return null;
    } finally {
      if (requests.current.current(token)) setCheckingTools(null);
    }
  };
  const devices = async () => {
    const token = requests.current.begin('devices');
    const state = await window.blode.getState().catch((e) => {
      if (requests.current.current(token)) throw e;
      return null;
    });
    if (!state) return;
    if (!requests.current.current(token)) return;
    setApp(state);
    if (state.installation && state.installation.id === installationOwner.current.id)
      setInstallation((current) =>
        current && current.updatedAt > state.installation!.updatedAt ? current : state.installation,
      );
    setConfig((current) => {
      if (
        busyRef.current ||
        (debugRef.current && ['running', 'stopped', 'connecting'].includes(debugRef.current.connection))
      )
        return current;
      const target =
        state.config.boardId !== 'auto'
          ? state.config
          : (state.boards.find((board) => board.id === 'STM32F103C8T6')?.defaultConfig as ProjectConfig);
      const next =
        current?.boardId === target?.boardId
          ? { ...target, programmer: current.programmer, debugger: current.debugger ?? target.debugger }
          : target;
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
      const progress = event.installation;
      const owner = installationOwner.current;
      if (
        progress &&
        owner.requested &&
        !owner.id &&
        progress.tool === 'GDB / debug server' &&
        progress.phase === 'starting'
      )
        owner.id = progress.id;
      if (progress && progress.id === owner.id)
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
        void devices().catch(reportError);
    });
    void devices().catch(reportError);
    const tick = async () => {
      if (pending || busyRef.current) return;
      pending = true;
      try {
        await refresh();
      } catch (e) {
        if (!disposed) reportError(e);
      } finally {
        pending = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      disposed = true;
      requests.current.invalidate();
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const act = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    requests.current.invalidate();
    const actionRequest = requests.current.begin('action');
    busyRef.current = true;
    setBusy(true);
    setError('');
    setPatchResult('');
    try {
      await action();
      if (requests.current.current(actionRequest)) await refresh();
    } catch (e) {
      if (requests.current.current(actionRequest)) reportError(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const command = (action: DebuggerAction) => void act(() => window.blode.debuggerAction(action));
  const chooseSymbols = () =>
    void act(async () => {
      if (!(await refresh())) return;
      const token = requests.current.begin('storage');
      const chosen = await window.blode.debuggerSymbols();
      if (chosen) {
        const next = await window.blode.debuggerStorage();
        if (requests.current.current(token)) setStorage(next);
      }
    });
  const readMemory = () =>
    void act(async () => {
      const start = Number(address);
      const token = requests.current.begin('memory');
      const session = debugRef.current?.sessionId;
      const contents = await window.blode.debuggerMemory(start, length);
      const fresh = await refresh();
      if (
        fresh &&
        requests.current.current(token) &&
        fresh.sessionId === session &&
        fresh.connection === 'stopped'
      )
        setMemory({ contents, address: start, time: new Date().toISOString() });
    });
  const openDialog = (next: typeof dialog) => {
    setDialog(next);
  };
  const editInstruction = (item: NonNullable<DebuggerState['instructions']>[number]) => {
    setPatch(item);
    setPatchSession(debugRef.current?.sessionId ?? '');
    setPatchBytes(item.opcodes ?? '');
    setPatchMode('hex');
    setAssembly(instructionAssembly(item.instruction));
    setAssembled(false);
    setPatchResume(false);
    setPatchResult('');
  };
  const dialogAct = async (action: () => Promise<unknown>) => {
    await act(action);
  };
  const addBatch = () =>
    void dialogAct(async () => {
      const token = requests.current.begin('batch');
      const next = await window.blode.debuggerBreakpoints(breakpointLocations(batchText));
      if (requests.current.current(token)) setBatchResults(next);
    });
  const writeInstruction = () =>
    void dialogAct(async () => {
      if (!patch || !patchSession || patchSession !== debugRef.current?.sessionId) return;
      const token = requests.current.begin('patch');
      const result = await window.blode.debuggerPatch({
        address: numberOf(patch.address),
        sessionId: patchSession,
        expected: machineCodeBytes(patch.opcodes ?? '')!,
        bytes: machineCodeBytes(patchBytes)!,
        pauseAndResume: patchResume,
        confirm: true,
      });
      if (!requests.current.current(token)) return;
      setPatch(null);
      setPatchResult(t(result.resumed ? 'debugger.patch.appliedRunning' : 'debugger.patch.applied'));
      setMemory(null);
    });
  const assembleInstruction = () =>
    void dialogAct(async () => {
      if (!patch) return;
      const token = requests.current.begin('assembly');
      const bytes = await window.blode.debuggerAssemble(numberOf(patch.address), assembly);
      if (!requests.current.current(token)) return;
      setPatchBytes(bytes);
      setAssembled(true);
    });
  const installTools = () =>
    void dialogAct(async () => {
      installationOwner.current = { requested: true };
      setInstallation(undefined);
      setInstalling(true);
      try {
        await window.blode.debuggerInstallTools(configRef.current ?? undefined);
      } finally {
        installationOwner.current.requested = false;
        setInstalling(false);
      }
    });
  const changeToolPath = (key: 'gdbPath' | 'serverPath' | 'scriptsPath', value: string) => {
    if (toolsLocked || !configRef.current) return;
    requests.current.begin('state');
    const next = { ...configRef.current, debugger: { ...configRef.current.debugger, [key]: value } };
    configRef.current = next;
    setConfig(next);
    checkedToolsRef.current = undefined;
    setCheckedTools(undefined);
    setCheckingTools(null);
  };
  const menus: DebuggerMenu[] = [
    {
      label: t('debugger.menu.connection'),
      items: [
        {
          label: t('debugger.connectionSettings'),
          run: () => openDialog('connection'),
          disabled: !builtinPanels,
        },
        { label: t('debugger.disconnect'), run: () => command('disconnect'), disabled: !connected || busy },
      ],
    },
    {
      label: t('debugger.menu.debug'),
      items: [
        ...commandKeys.map((action) => ({
          label: t(`debugger.${action}`),
          run: () => command(action),
          disabled: !builtinPanels || busy || (action === 'pause' ? !connected || stopped : !stopped),
        })),
        {
          label: t('debugger.batch.title'),
          run: () => openDialog('breakpoints'),
          disabled: !builtinPanels || !stopped || busy,
        },
      ],
    },
    {
      label: t('menu.view'),
      items: tabs.map(({ id }) => ({
        label: t(`debugger.dashboard.tab.${id}`),
        checked: view === id,
        disabled: !builtinPanels,
        run: () => setView(id),
      })),
    },
    {
      label: t('debugger.menu.tools'),
      items: [
        {
          label: t('debugger.symbols'),
          run: chooseSymbols,
          disabled: !builtinPanels || connected || attaching || busy,
        },
        {
          label: t('debugger.toolSettings'),
          run: () => openDialog('tools'),
          disabled: !nativeDebugger || customOnly,
        },
      ],
    },
  ];
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
  const coreRegisterNames = profile?.registers ?? [...record.keys()];
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
        <button
          className="debug-heading-action"
          disabled={!stopped || busy}
          onClick={() => openDialog('breakpoints')}
        >
          <Plus size={13} />
          {t('debugger.batch.title')}
        </button>
      </h2>
      <div className="debug-inline">
        <input
          aria-label={t('debugger.breakpoints')}
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder={`main / main.c:20 / *${usbJtag ? '0x42000100' : '0x08000100'}`}
        />
        <button
          disabled={!stopped || busy || !location.trim()}
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
                {patchSupported && (
                  <th>
                    <span className="sr-only">{t('debugger.patch.title')}</span>
                  </th>
                )}
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
                  {patchSupported && (
                    <td className="debug-instruction-edit">
                      <button
                        className="icon-button"
                        aria-label={`${t('debugger.patch.title')} ${item.address}`}
                        title={t('debugger.patch.title')}
                        disabled={!nativeDebugger || !connected || busy}
                        onClick={() => editInstruction(item)}
                      >
                        <Pencil size={13} />
                      </button>
                    </td>
                  )}
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
      {profile?.statusRegister && (
        <div className="debug-flags">
          <span>{profile.statusRegister.toUpperCase()}</span>
          <code>{register(profile.statusRegister)}</code>
          {profile.flags.map(({ name, bit }) => (
            <span className="debug-flag" key={name}>
              {name}
              <b>{Number.isFinite(psr) ? (psr >>> bit) & 1 : '—'}</b>
            </span>
          ))}
        </div>
      )}
    </section>
  );
  const memoryPanel = (
    <section className="debug-card debug-memory-view">
      <h2>
        <MemoryStick size={15} />
        {t('debugger.memory')}
        <button
          className="primary debug-heading-action"
          disabled={!stopped || busy || !validMemoryRange(address, length)}
          onClick={readMemory}
        >
          <RefreshCw size={13} />
          {t('debugger.read')}
        </button>
      </h2>
      <div className="debug-memory-presets">
        {(registeredProfile ?? debug?.profile)?.memoryRegions.map((region) => (
          <button
            key={`${region.name}-${region.start}`}
            title={`${hexAddress(region.start)} – ${hexAddress(region.end - 1)}`}
            onClick={() => setAddress(hexAddress(region.start))}
          >
            {region.name} · {hexAddress(region.start)}
          </button>
        ))}
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
      <form
        className="debug-memory-fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (stopped && !busy && validMemoryRange(address, length)) readMemory();
        }}
      >
        <label>
          {t('debugger.address')}
          <input value={address} spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
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
        <button className="debug-memory-submit" type="submit" tabIndex={-1} aria-hidden="true" />
      </form>
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

  const connectionForm = (
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
      ) : usbJtag ? (
        <label>
          <span>
            {profile.connection} · {t('debugger.usbSerial')}
          </span>
          <input
            value={config?.debugger?.serialNumber ?? ''}
            placeholder={t('debugger.usbSerialAuto')}
            disabled={connected || attaching || busy}
            spellCheck={false}
            onChange={(event) =>
              setConfig((current) =>
                current
                  ? { ...current, debugger: { ...current.debugger, serialNumber: event.target.value } }
                  : current,
              )
            }
          />
        </label>
      ) : (
        nativeDebugger && (
          <>
            <label>
              <span>{profile?.connection ?? 'ST-Link / SWD'}</span>
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
          {!usbJtag && (
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
          )}
          <label className="debug-frequency">
            <span>{t(usbJtag ? 'debugger.jtagFrequency' : 'debugger.dashboard.frequency')}</span>
            <input
              aria-label={t(usbJtag ? 'debugger.jtagFrequency' : 'debugger.dashboard.frequency')}
              type="number"
              min={frequency.min}
              max={frequency.max}
              disabled={connected || attaching || busy}
              value={
                (usbJtag ? config?.debugger?.frequencyKhz : config?.programmer?.frequencyKhz) ??
                frequency.default
              }
              onChange={(event) =>
                setConfig((current) =>
                  current
                    ? {
                        ...current,
                        ...(usbJtag
                          ? { debugger: { ...current.debugger, frequencyKhz: Number(event.target.value) } }
                          : {
                              programmer: {
                                transport: 'stlink',
                                serialNumber: current.programmer?.serialNumber ?? '',
                                frequencyKhz: Number(event.target.value),
                              },
                            }),
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
          (!pluginDebugger && ((!usbJtag && !selectedSerial) || !currentTools?.gdb || !currentTools?.server))
        }
        onClick={() =>
          config &&
          void dialogAct(async () => {
            await window.blode.debuggerConnect(config);
            setDialog(null);
          })
        }
      >
        {t('debugger.connect')}
      </button>
      <button disabled={(!connected && !attaching) || busy} onClick={() => command('disconnect')}>
        {t('debugger.disconnect')}
      </button>
    </section>
  );

  return (
    <>
      <RuntimePluginTrustDialog id={config?.boardId} />
      {dialog && (
        <DebuggerDialog
          title={t(
            dialog === 'connection'
              ? 'debugger.connectionSettings'
              : dialog === 'tools'
                ? 'debugger.toolSettings'
                : 'debugger.batch.title',
          )}
          closeLabel={t('action.close')}
          onClose={() => setDialog(null)}
          busy={busy}
        >
          {dialog === 'connection' && (
            <>
              {selectedRuntime && <p className="debug-dialog-target">{selectedRuntime.name}</p>}
              {connectionForm}
              {nativeDebugger && currentTools && (!currentTools.gdb || !currentTools.server) && (
                <button onClick={() => openDialog('tools')}>
                  {t(profile?.tools.missingKey ?? 'debugger.toolsMissing')} · {t('debugger.toolSettings')}
                </button>
              )}
            </>
          )}
          {dialog === 'tools' && (
            <>
              <DebuggerToolsPanel
                profile={profile}
                tools={currentTools}
                checking={checkingTools === toolIdentity}
                disabled={toolsLocked}
                web={isWeb}
                paths={config?.debugger}
                onChange={changeToolPath}
                onCheck={() => void dialogAct(() => refresh(true))}
                onChooseGdb={() =>
                  void dialogAct(async () => {
                    if (!(await refresh(true))) return;
                    const chosen = await window.blode.debuggerChooseGdb();
                    if (chosen && configRef.current) {
                      const next = {
                        ...configRef.current,
                        debugger: { ...configRef.current.debugger, gdbPath: '' },
                      };
                      configRef.current = next;
                      setConfig(next);
                      checkedToolsRef.current = undefined;
                      setCheckedTools(undefined);
                    }
                  })
                }
                onInstall={installTools}
              />
              {(installation || installing) && (
                <InstallationOutput installation={installation} pending={installing} />
              )}
            </>
          )}
          {dialog === 'breakpoints' && (
            <>
              <label className="debug-dialog-field">
                {t('debugger.batch.locations')}
                <textarea
                  autoFocus
                  rows={7}
                  spellCheck={false}
                  value={batchText}
                  disabled={busy}
                  placeholder={`main\nmain.c:20\n*${usbJtag ? '0x42000100' : '0x08000100'}`}
                  onChange={(event) => {
                    setBatchText(event.target.value);
                    setBatchResults([]);
                  }}
                />
              </label>
              <div className="debug-dialog-actions">
                <span>{breakpointLocations(batchText).length} / 128</span>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !stopped ||
                    breakpointLocations(batchText).length < 1 ||
                    breakpointLocations(batchText).length > 128
                  }
                  onClick={addBatch}
                >
                  <Plus size={14} />
                  {t('debugger.batch.add')}
                </button>
              </div>
              {!!batchResults.length && (
                <ul className="debug-batch-results" aria-live="polite">
                  {batchResults.map((result, index) => (
                    <li
                      key={`${result.location}-${index}`}
                      className={result.status === 'failed' ? 'is-failed' : ''}
                    >
                      <code>{result.location}</code>
                      <span>
                        {result.error ? t(result.error) : t(`debugger.batch.${result.status}`)}
                        {result.id ? ` #${result.id}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {errorNotice}
        </DebuggerDialog>
      )}
      {patch && (
        <DebuggerDialog
          title={t('debugger.patch.title')}
          closeLabel={t('action.close')}
          onClose={() => setPatch(null)}
          busy={busy}
        >
          <div className="debug-patch-original">
            <code>{patch.address}</code>
            <code>{patch.instruction}</code>
          </div>
          <label className="debug-dialog-field">
            {t('debugger.patch.original')}
            <input readOnly value={patch.opcodes ?? '—'} />
          </label>
          {!canPatchInstruction(numberOf(patch.address), patch.opcodes) && (
            <p className="debug-patch-limit">
              {t(
                numberOf(patch.address) >= 0x08000000 && numberOf(patch.address) < 0x10000000
                  ? 'debugger.patch.flashReadOnly'
                  : 'debugger.patch.sramOnly',
              )}
            </p>
          )}
          <div className="debug-input-mode" role="group" aria-label={t('debugger.patch.inputMode')}>
            {(['hex', 'assembly'] as const).map((mode) => (
              <button
                key={mode}
                aria-pressed={patchMode === mode}
                disabled={busy}
                onClick={() => {
                  setPatchMode(mode);
                  setAssembled(false);
                  setPatchBytes(patch.opcodes ?? '');
                  setPatchResult('');
                }}
              >
                {t(`debugger.patch.${mode}`)}
              </button>
            ))}
          </div>
          {patchMode === 'assembly' ? (
            <>
              <label className="debug-dialog-field">
                {t('debugger.patch.assembly')}
                <input
                  autoFocus
                  value={assembly}
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => {
                    setAssembly(event.target.value);
                    setAssembled(false);
                    setPatchBytes('');
                    setPatchResult('');
                  }}
                />
              </label>
              <div className="debug-assembly-preview">
                <button disabled={busy || !assembly.trim()} onClick={assembleInstruction}>
                  {t('debugger.patch.assemble')}
                </button>
                <code>{assembled ? patchBytes : '—'}</code>
              </div>
            </>
          ) : (
            <label className="debug-dialog-field">
              {t('debugger.patch.replacement')}
              <input
                autoFocus
                value={patchBytes}
                spellCheck={false}
                disabled={busy}
                onChange={(event) => {
                  setPatchBytes(event.target.value);
                  setPatchResult('');
                }}
                placeholder="00 bf"
              />
            </label>
          )}
          <p className="debug-muted">{t('debugger.patch.byteOrder')}</p>
          {debug?.connection === 'running' && (
            <label className="debug-patch-resume">
              <input
                type="checkbox"
                checked={patchResume}
                disabled={busy}
                onChange={(event) => setPatchResume(event.target.checked)}
              />
              {t('debugger.patch.pauseResume')}
            </label>
          )}
          <div className="debug-dialog-actions">
            <button disabled={busy} onClick={() => setPatch(null)}>
              {t('action.cancel')}
            </button>
            <button
              className="primary"
              onClick={writeInstruction}
              disabled={
                busy ||
                !patchSession ||
                patchSession !== debug?.sessionId ||
                !connected ||
                !canPatchInstruction(numberOf(patch.address), patch.opcodes) ||
                !machineCodeBytes(patchBytes) ||
                machineCodeBytes(patchBytes)?.length !== machineCodeBytes(patch.opcodes ?? '')?.length ||
                machineCodeBytes(patchBytes) === machineCodeBytes(patch.opcodes ?? '') ||
                (patchMode === 'assembly' && !assembled) ||
                (!stopped && !patchResume)
              }
            >
              {t('debugger.patch.write')}
            </button>
          </div>
          {errorNotice}
        </DebuggerDialog>
      )}
      <header className="topbar debug-titlebar">
        <span className="brand-name">Blode Studio</span>
        <DebuggerMenubar menus={menus} label={t('debugger.menu.label')} />
        <span className="topbar-spacer" aria-hidden="true" />
        <span className={`debug-state state-${debug?.connection ?? 'disconnected'}`}>
          {t(`debugger.state.${debug?.connection ?? 'disconnected'}`)}
        </span>
        {customTitlebar && (
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
        )}
      </header>
      <div className="hardware-debugger debug-has-titlebar">
        {!debugSupported && config && (
          <div className="debug-runtime-status">{t('debugger.runtimeUnsupported')}</div>
        )}
        {!dialog && !patch && errorNotice}
        {patchResult && (
          <p className="debug-patch-result" role="status">
            {patchResult}
          </p>
        )}
        {builtinPanels && (
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
            {debug?.updatedAt && (
              <time className="debug-sample-stamp" dateTime={debug.updatedAt}>
                {t('debugger.dashboard.sampleTime')}: {sampleTime}
              </time>
            )}
          </div>
        )}
        {builtinPanels && (
          <div className="debug-execution-toolbar">
            {commandKeys.map((action) => (
              <button
                key={action}
                disabled={busy || (action === 'pause' ? debug?.connection !== 'running' : !stopped)}
                onClick={() => command(action)}
              >
                {action === 'continue' && <Play size={13} />}
                {action === 'pause' && <Pause size={13} />}
                {t(`debugger.${action}`)}
              </button>
            ))}
            {view !== 'storage' && (
              <div className="debug-symbol-control">
                <span title={debug?.symbols}>{debug?.symbols || t('debugger.noSymbols')}</span>
              </div>
            )}
          </div>
        )}
        <main
          className="debug-page-content"
          role={builtinPanels ? 'tabpanel' : undefined}
          id={`debug-panel-${view}`}
          aria-labelledby={builtinPanels ? `debug-tab-${view}` : undefined}
        >
          {plugin?.debugger.view && (
            <section className="debug-card debug-plugin-view">
              <RuntimePluginView id={plugin.id} kind="debugger" />
            </section>
          )}
          {builtinPanels && (
            <>
              {view === 'overview' && (
                <>
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
                    </h2>
                    <div className="debug-inline">
                      <button disabled={connected || attaching || busy} onClick={chooseSymbols}>
                        {t('debugger.symbols')}
                      </button>
                      <span>{debug?.symbols || t('debugger.noSymbols')}</span>
                    </div>
                    {storage && (
                      <>
                        <div className="debug-file-summary">
                          <FileCode2 size={24} />
                          <strong>{storage.name}</strong>
                          <span>{bytesLabel(storage.size)}</span>
                          <span>
                            {registeredProfile?.architecture === 'xtensa'
                              ? 'Xtensa ELF'
                              : registeredProfile?.architecture === 'arm-thumb'
                                ? 'ARM ELF'
                                : 'ELF'}
                          </span>
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
                    {diagnosticLog.map((line) => t(line)).join('\n') || t('debugger.dashboard.logEmpty')}
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
