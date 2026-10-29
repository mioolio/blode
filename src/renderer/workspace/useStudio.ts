import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppState,
  DriverId,
  LogEvent,
  ProjectConfig,
  RecentProject,
  SerialOptions,
  InstallationState,
} from '../../shared/contracts';
import { useI18n } from '../i18n';
import { parseWorkspaceRoute, workspaceRouteHash, type WorkspaceRoute } from './routes';
import { validatesExistingFirmware } from './buildMode';
import { previewFile, pinFileTab, persistentFiles } from './tabs';
import { diagnosticLevel } from './diagnostics';

type View = 'code' | 'layout' | 'ai';
type ToolTab = 'layout' | 'ai';
type ConsoleTab = 'output' | 'serial' | 'problems' | 'warnings';

const toolTabViews: Record<ToolTab, View> = { layout: 'layout', ai: 'ai' };

function viewFromRoute(route: WorkspaceRoute): View {
  if (route.kind === 'layout') return 'layout';
  if (route.kind === 'automation') return 'ai';
  return 'code';
}

const isToolTab = (value: unknown): value is ToolTab => value === 'layout' || value === 'ai';

function initialToolTabs(route: WorkspaceRoute): ToolTab[] {
  const routeTool: ToolTab | null =
    route.kind === 'layout' ? 'layout' : route.kind === 'automation' ? 'ai' : null;
  return routeTool ? [routeTool] : [];
}

interface StoredSession {
  openFiles: string[];
  openTools: ToolTab[];
  activePath: string;
}

const sessionKey = (root: string) => `blode.session:${root}`;
function retainDraftConfig(pending: ProjectConfig, next: AppState): ProjectConfig {
  const port =
    pending.port &&
    !next.ports.some((item) => item.path === pending.port) &&
    !(next.connections?.serial.open && next.connections.serial.port === pending.port)
      ? ''
      : pending.port;
  const missingProbe =
    next.connections?.probes.state === 'ready' &&
    pending.programmer?.serialNumber &&
    !next.debugProbes.some(
      (item) => item.serialNumber.toLowerCase() === pending.programmer!.serialNumber.toLowerCase(),
    );
  return {
    ...pending,
    port,
    ...(missingProbe ? { programmer: { ...pending.programmer!, serialNumber: '' } } : {}),
  };
}

/** Electron wraps IPC failures; keep the protocol key so the UI can translate it. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Per-project tab state survives reloads; missing or corrupt data means a fresh start. */
function readSession(root: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(root));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    return {
      openFiles:
        parsed.version === 2 && Array.isArray(parsed.openFiles)
          ? parsed.openFiles.filter((value): value is string => typeof value === 'string')
          : [],
      openTools: Array.isArray(parsed.openTools) ? parsed.openTools.filter(isToolTab) : [],
      activePath: parsed.version === 2 && typeof parsed.activePath === 'string' ? parsed.activePath : '',
    };
  } catch {
    return null;
  }
}

export function useStudio() {
  const { t, locale } = useI18n();
  const route = useRef<WorkspaceRoute | null>(null);
  if (!route.current) route.current = parseWorkspaceRoute();
  const initial = route.current;
  const [state, setState] = useState<AppState | null>(null);
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activePath, setActivePath] = useState(initial.kind === 'editor' ? (initial.file ?? '') : '');
  const [openFiles, setOpenFiles] = useState<string[]>(
    initial.kind === 'editor' && initial.file ? [initial.file] : [],
  );
  const [openTools, setOpenTools] = useState<ToolTab[]>(() => initialToolTabs(initial));
  const [previewPath, setPreviewPath] = useState(initial.kind === 'editor' ? (initial.file ?? '') : '');
  const previewPathRef = useRef(previewPath);
  const [showHome, setShowHome] = useState(false);
  const [closeProjectPending, setCloseProjectPending] = useState(false);
  const [view, setView] = useState<View>(viewFromRoute(initial));
  const openFilesRef = useRef(openFiles);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);
  const activePathRef = useRef(activePath);
  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);
  const viewRef = useRef<View>(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [installation, setInstallation] = useState<InstallationState>();
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ message: string; error?: boolean; warning?: boolean } | null>(null);
  const [tab, setTab] = useState<ConsoleTab>('output');
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialInput, setSerialInput] = useState('');
  const [serialBaud, setSerialBaud] = useState(115200);
  const [serialOptions, setSerialOptions] = useState<SerialOptions>({
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
  });
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [probeFailure, setProbeFailure] = useState<{ message: string } | null>(null);
  const [recentMissing, setRecentMissing] = useState<RecentProject | null>(null);
  const [syncDrafts, setSyncDrafts] = useState(() => localStorage.getItem('blode.sync') !== 'off');
  const isWeb = window.__blodeWeb === true;
  const [confirmFlash, setConfirmFlash] = useState(false);
  const [stale, setStale] = useState(false);
  const [widths, setWidths] = useState({ left: 224, right: 284, bottom: 207 });
  const [devicePanelVisible, setDevicePanelVisible] = useState(() => {
    try {
      return localStorage.getItem('blode.devicePanel') !== 'hidden';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('blode.devicePanel', devicePanelVisible ? 'visible' : 'hidden');
    } catch {}
  }, [devicePanelVisible]);
  const logEnd = useRef<HTMLDivElement>(null);
  const restoredFolder = useRef('');
  const dirty = Object.keys(drafts).length > 0;
  const configDirty = !!state && !!config && JSON.stringify(state.config) !== JSON.stringify(config);
  const source = state?.files.find((file) => file.path === activePath);
  const content = drafts[activePath] ?? source?.content ?? '';
  const lines = content.split('\n');
  const comments = lines.filter((line) => /^\s*(\/\/|\/\*|\*|\*\/)/.test(line)).length;
  const longLines = lines.filter((line) => line.length > 100).length;
  const errors = logs.filter((log) => log.level === 'error');
  const warnings = logs.filter((log) => log.level === 'warning');
  const board = state?.boards.find((item) => item.id === config?.boardId);
  const isStm32 = config?.boardId === 'stm32';
  const isAuto = config?.boardId === 'auto';
  const usesStlink = isStm32 || config?.programmer?.transport === 'stlink';
  const hasBuildEntry = !!(state?.build?.entry ?? state?.build?.sketch);
  const validatesFirmware = validatesExistingFirmware(board, state?.build);
  useEffect(() => {
    const connected = state?.connections?.serial;
    if (!connected?.open) return;
    setSerialBaud(connected.baudRate);
    if (connected.options) setSerialOptions(connected.options);
  }, [state?.connections?.serial]);

  const notify = useCallback(
    (message: string, error = false, warning = false) => setToast({ message, error, warning }),
    [],
  );
  const refresh = useCallback(async () => {
    const next = await window.blode.getState();
    setState(next);
    setInstallation(next.installation);
    setSerialConnected(!!next.connections?.serial.open);
    setConfig(next.config);
    setStale(next.buildStale ?? false);
    const exists = (path: string) => next.files.some((file) => file.path === path);
    if (restoredFolder.current !== next.projectRoot) {
      restoredFolder.current = next.projectRoot;
      let restoredDraftPaths: string[] = [];
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`blode.drafts:${next.projectRoot}`) ?? '{}');
        const editable = new Map(next.files.map((file) => [file.path, file.content]));
        restoredDraftPaths =
          saved && typeof saved === 'object'
            ? Object.entries(saved)
                .filter(
                  ([path, value]) =>
                    editable.has(path) && typeof value === 'string' && value !== editable.get(path),
                )
                .map(([path]) => path)
            : [];
        setDrafts(
          saved && typeof saved === 'object'
            ? Object.fromEntries(
                Object.entries(saved).filter(
                  ([path, value]) =>
                    editable.has(path) && typeof value === 'string' && value !== editable.get(path),
                ),
              )
            : {},
        );
      } catch {
        setDrafts({});
      }
      // Restore the exact tab set the user left behind, including closed tabs.
      // A first visit only opens the deepest route file or the first project file.
      const session = readSession(next.projectRoot);
      const current = activePathRef.current;
      let nextOpen: string[];
      let nextActive: string;
      if (session) {
        nextOpen = session.openFiles.filter(exists);
        if (current && exists(current) && !nextOpen.includes(current)) nextOpen = [...nextOpen, current];
        nextActive =
          current && nextOpen.includes(current)
            ? current
            : session.activePath && nextOpen.includes(session.activePath)
              ? session.activePath
              : (nextOpen[0] ?? '');
      } else {
        nextOpen = current && exists(current) ? [current] : next.files[0] ? [next.files[0].path] : [];
        nextActive = nextOpen[0] ?? '';
      }
      nextOpen = [...new Set([...nextOpen, ...restoredDraftPaths])];
      if (!nextActive) nextActive = nextOpen[0] ?? '';
      const restoredTools = session ? session.openTools : [];
      const activeTool = viewRef.current === 'code' ? null : (viewRef.current as ToolTab);
      const nextTools =
        activeTool && !restoredTools.includes(activeTool) ? [...restoredTools, activeTool] : restoredTools;
      openFilesRef.current = nextOpen;
      const proposedPreview =
        nextOpen.includes(current) && !session?.openFiles.includes(current)
          ? current
          : !session
            ? nextActive
            : '';
      const nextPreview = restoredDraftPaths.includes(proposedPreview) ? '' : proposedPreview;
      previewPathRef.current = nextPreview;
      setPreviewPath(nextPreview);
      activePathRef.current = nextActive;
      setOpenFiles(nextOpen);
      setActivePath(nextActive);
      setOpenTools(nextTools);
      return next;
    }
    const nextOpen = openFilesRef.current.filter(exists);
    const nextActive =
      activePathRef.current && exists(activePathRef.current) ? activePathRef.current : (nextOpen[0] ?? '');
    openFilesRef.current = nextOpen;
    activePathRef.current = nextActive;
    setOpenFiles(nextOpen);
    setActivePath(nextActive);
    return next;
  }, []);
  useEffect(() => {
    if (!state?.projectRoot || restoredFolder.current !== state.projectRoot) return;
    try {
      localStorage.setItem(`blode.drafts:${state.projectRoot}`, JSON.stringify(drafts));
    } catch {
      /* The editor remains usable when local storage is unavailable. */
    }
  }, [drafts, state?.projectRoot]);
  useEffect(() => {
    const preview = previewPathRef.current;
    if (
      preview &&
      drafts[preview] !== undefined &&
      drafts[preview] !== state?.files.find((file) => file.path === preview)?.content
    )
      pinFile(preview);
  }, [drafts, state?.files]);
  useEffect(() => {
    const root = state?.projectRoot;
    if (!root || restoredFolder.current !== root) return;
    try {
      const retained = persistentFiles({ files: openFiles, preview: previewPath });
      localStorage.setItem(
        sessionKey(root),
        JSON.stringify({
          version: 2,
          openFiles: retained,
          openTools,
          activePath: retained.includes(activePath) ? activePath : '',
        }),
      );
    } catch {
      /* Tab state is optional. */
    }
  }, [state?.projectRoot, openFiles, openTools, activePath, previewPath]);
  useEffect(() => {
    try {
      localStorage.setItem('blode.sync', syncDrafts ? 'on' : 'off');
    } catch {
      /* Sync preference is optional. */
    }
  }, [syncDrafts]);
  useEffect(() => {
    if (isWeb || !syncDrafts || !state?.web?.endpoint) return;
    const timer = setTimeout(() => window.blode.publishDrafts(drafts), 500);
    return () => clearTimeout(timer);
  }, [drafts, isWeb, syncDrafts, state?.web?.endpoint]);
  useEffect(() => {
    if (isWeb || syncDrafts || !state?.web?.endpoint) return;
    window.blode.publishDrafts({});
  }, [isWeb, syncDrafts, state?.web?.endpoint]);
  useEffect(() => {
    if (!isWeb || !syncDrafts) return;
    return window.blode.onDrafts((incoming) => {
      const editable = new Set(state?.files.map((file) => file.path) ?? []);
      setDrafts(Object.fromEntries(Object.entries(incoming).filter(([path]) => editable.has(path))));
    });
  }, [isWeb, syncDrafts, state?.files]);
  useEffect(() => {
    if (view === 'code') return;
    const tool = view as ToolTab;
    setOpenTools((current) => (current.includes(tool) ? current : [...current, tool]));
  }, [view]);
  useEffect(() => {
    const route: WorkspaceRoute =
      view === 'layout'
        ? { kind: 'layout' }
        : view === 'ai'
          ? { kind: 'automation' }
          : { kind: 'editor', ...(activePath && activePath !== previewPath ? { file: activePath } : {}) };
    const hash = workspaceRouteHash(route);
    if (window.location.hash !== hash) {
      try {
        window.history.replaceState(null, '', hash);
      } catch {
        /* A restricted host may reject history updates; navigation still works. */
      }
    }
  }, [view, activePath, previewPath]);
  useEffect(() => {
    if (!window.blode) {
      notify(t('toast.desktop'), true);
      return;
    }
    void refresh().catch((error) => notify(String(error), true));
    return window.blode.onEvent((event) => {
      if (event.installation) {
        setInstallation((current) => ({
          ...event.installation!,
          logs: event.progressOnly
            ? current?.id === event.installation!.id
              ? current.logs
              : []
            : [...(current?.id === event.installation!.id ? current.logs.slice(-299) : []), event],
        }));
      }
      if (event.progressOnly) return;
      const classified =
        event.level === 'error' ? { ...event, level: diagnosticLevel(event.message) } : event;
      setLogs((current) => [...current.slice(-999), classified]);
      if (event.message === 'status.serialDisconnected') setSerialConnected(false);
      if (event.message === 'status.serialConnected') setSerialConnected(true);
    });
  }, [refresh, notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [logs, tab]);
  // Refresh external AI changes only when local edits are safe to retain.
  useEffect(() => {
    if (!window.blode) return;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = window.blode.onEvent((event) => {
      if (
        busy ||
        ![
          'status.fileSaved',
          'status.configSaved',
          'status.buildEntrySet',
          'status.buildSucceeded',
          'status.buildFailed',
          'status.projectOpened',
          'status.workspaceChanged',
          'status.deviceSelectionCleared',
          'status.devicesChanged',
          'status.serialConnected',
          'status.serialDisconnected',
          'status.debuggerDisconnected',
          'status.projectClosed',
        ].includes(event.message)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void window.blode
          .getState()
          .then((next) => {
            setState(next);
            setSerialConnected(!!next.connections?.serial.open);
            setConfig((current) => (configDirty && current ? retainDraftConfig(current, next) : next.config));
            setStale(next.buildStale ?? false);
            if (['status.fileSaved', 'status.configSaved', 'status.buildEntrySet'].includes(event.message))
              setStale(true);
          })
          .catch((error) => notify(String(error), true));
      }, 200);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [busy, configDirty, notify]);

  const perform = async (label: string, operation: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(label);
    try {
      await operation();
      return true;
    } catch (error) {
      const message = messageOf(error);
      const level = diagnosticLevel(message);
      notify(t(message), level === 'error', level === 'warning');
      setLogs((current) =>
        current.at(-1)?.level === level && current.at(-1)?.message === message
          ? current
          : [...current.slice(-999), { kind: 'log', level, message, time: new Date().toISOString() }],
      );
      setTab(level === 'warning' ? 'warnings' : 'output');
      return false;
    } finally {
      setBusy('');
    }
  };
  const saveFiles = async () => {
    const snapshot = { ...drafts };
    for (const [path, value] of Object.entries(snapshot)) await window.blode.saveFile(path, value);
    // Retain keystrokes entered while an asynchronous write was completing.
    setDrafts((current) =>
      Object.fromEntries(Object.entries(current).filter(([path, value]) => snapshot[path] !== value)),
    );
  };
  const save = () =>
    perform('action.save', async () => {
      if (activePath && state?.workspaceOpen) pinFile(activePath);
      await saveFiles();
      if (config && configDirty) {
        await window.blode.saveConfig(config);
        setStale(true);
      }
      await refresh();
      notify(t('toast.saved'));
    });
  const saveConfig = () =>
    perform('action.apply', async () => {
      if (config) {
        await window.blode.saveConfig(config);
        setStale(true);
        await refresh();
        notify(t('toast.configSaved'));
      }
    });
  const setBuildEntry = (entry: string) =>
    perform('action.setBuildEntry', async () => {
      // The entry is persisted in be. Do not let an older unsaved descriptor
      // silently overwrite it later; ordinary source drafts remain untouched.
      if (Object.keys(drafts).some((file) => file.toLowerCase() === 'be')) throw new Error('toast.saveFirst');
      const pendingConfig = configDirty ? config : null;
      await window.blode.setBuildEntry(entry);
      await refresh();
      if (pendingConfig) setConfig(pendingConfig);
      setStale(true);
      notify(t('toast.buildEntrySet'));
    });
  /** Rename a file or a whole folder and keep tabs/drafts pointing at the new paths. */
  const renamePath = (from: string, to: string) =>
    perform('action.rename', async () => {
      if (from === to) return;
      await window.blode.renameEntry(from, to);
      const remap = (value: string) =>
        value === from ? to : value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
      setDrafts((current) => {
        const next: Record<string, string> = {};
        for (const [path, value] of Object.entries(current)) next[remap(path)] = value;
        return next;
      });
      setOpenFiles((current) => {
        const next = [...new Set(current.map(remap))];
        openFilesRef.current = next;
        return next;
      });
      const nextActive = remap(activePathRef.current);
      activePathRef.current = nextActive;
      setActivePath(nextActive);
      await refresh();
      notify(t('toast.renamed'));
    });
  const removeEntry = () =>
    perform('action.deleteEntry', async () => {
      if (!deleteTarget) return;
      await window.blode.deleteEntry(deleteTarget);
      setDrafts((current) => {
        const next = { ...current };
        delete next[deleteTarget];
        return next;
      });
      setDeleteTarget(null);
      await refresh();
      notify(t('toast.deleted'));
    });
  const build = () =>
    perform(validatesFirmware ? 'action.validateFirmware' : 'action.build', async () => {
      if (
        !isAuto &&
        !board?.capabilities.some((capability) => capability === 'compile' || capability === 'flash')
      )
        throw new Error('error.detectBoardFirst');
      setTab('output');
      await saveFiles();
      if (config && configDirty) await window.blode.saveConfig(config);
      const result = await window.blode.build();
      await refresh();
      setStale(!result.success);
      if (result.success) notify(t(validatesFirmware ? 'toast.firmwareValidated' : 'toast.built'));
    });
  const flash = () => {
    if (!board?.capabilities.includes('flash')) {
      reportWarning('error.detectBoardFirst');
      return;
    }
    if (usesStlink ? !config?.programmer?.serialNumber : !config?.port) {
      reportWarning(usesStlink ? 'error.selectDebugProbe' : 'toast.noPort');
      return;
    }
    if (!state?.lastBuild?.success || state.buildStale || stale || dirty || configDirty) {
      reportWarning('toast.noBuild');
      return;
    }
    setConfirmFlash(true);
  };
  const probe = () =>
    perform('action.probe', async () => {
      if (!config) return;
      if (!isAuto && (usesStlink ? !config.programmer?.serialNumber : !config.port))
        throw new Error(usesStlink ? 'error.selectDebugProbe' : 'toast.noPort');
      setTab('output');
      setProbeFailure(null);
      try {
        // Probing works before a project is open. Persist the transport choice
        // only when there is a workspace; the core still updates its in-memory
        // config so board/device recognition is available on the welcome page.
        if (state?.workspaceOpen) {
          await window.blode.saveConfig(config);
          setState((current) => (current ? { ...current, config } : current));
          if (configDirty) setStale(true);
        }
        await window.blode.probe(
          isAuto || usesStlink ? undefined : config.port,
          state?.workspaceOpen ? undefined : config,
        );
        // The core resolves the device and owns its platform/capacity parsing.
        const next = await refresh();
        const detectedBoard = next.boards.find((item) => item.id === next.config.boardId);
        if (detectedBoard && next.config.boardId !== 'auto') {
          setStale(true);
          notify(`${t('toast.boardDetected')}${detectedBoard.name}`);
        }
      } catch (error) {
        // A dialog keeps the failure visible so the transcript can be exported.
        setProbeFailure({ message: messageOf(error) });
      }
    });
  /** The probe transcript is what a developer needs when detection fails. */
  const probeLog = () =>
    [
      'Blode Studio probe log',
      `time: ${new Date().toISOString()}`,
      `locale: ${locale}`,
      `board: ${config?.boardId ?? ''}`,
      `transport: ${config?.programmer?.transport ?? (isAuto ? 'auto' : 'serial')}`,
      `probe: ${config?.programmer?.serialNumber ?? ''}`,
      `swd kHz: ${config?.programmer?.frequencyKhz ?? ''}`,
      `port: ${config?.port ?? ''}`,
      '',
      ...logs.map((event) => `${event.time} [${event.level}] ${event.message}`),
    ].join('\n');
  const downloadProbeLog = async () => {
    try {
      const result = await window.blode.exportProbeLog(probeLog());
      if (result === 'saved') notify(t('toast.logDownloaded'));
      if (result === 'download-started') notify(t('toast.logDownloadStarted'));
    } catch (error) {
      notify(messageOf(error), true);
    }
  };
  const sendProbeFeedback = async () => {
    try {
      await navigator.clipboard.writeText(`${probeLog()}\n\nhttps://github.com/mioolio/blode/issues/new`);
      notify(t('toast.reportCopied'));
    } catch (error) {
      notify(messageOf(error), true);
    }
  };
  const chooseBoardManually = () => {
    setProbeFailure(null);
    notify(t('toast.selectBoardManually'));
  };
  const refreshPorts = () =>
    perform('action.refresh', async () => {
      const ports = await window.blode.listPorts();
      setState((current) => (current ? { ...current, ports } : current));
      setConfig((current) =>
        current?.port && !ports.some((port) => port.path === current.port) && !serialConnected
          ? { ...current, port: '' }
          : current,
      );
    });
  const refreshDebugProbes = () =>
    perform('action.refresh', async () => {
      // Enumerate using the transport, tool directory and SWD speed shown in
      // the inspector, including a connection choice that is not yet applied.
      if (state?.workspaceOpen && config && configDirty) {
        await window.blode.saveConfig(config);
        setStale(true);
      }
      const pending = state?.workspaceOpen ? undefined : config;
      const debugProbes = await window.blode.listDebugProbes();
      const next = await refresh();
      if (pending) {
        const retained = retainDraftConfig(pending, { ...next, debugProbes });
        setConfig(retained);
        setState({ ...next, config: retained, debugProbes });
      } else {
        setState({ ...next, debugProbes });
      }
    });
  const refreshAutoDevices = () =>
    perform('action.refresh', async () => {
      if (state?.workspaceOpen && config && configDirty) {
        await window.blode.saveConfig(config);
        setStale(true);
      }
      const pending = state?.workspaceOpen ? undefined : config;
      const detection = await window.blode.scanDevices();
      const next = await refresh();
      if (pending) {
        const retained = retainDraftConfig(pending, { ...next, detection });
        setConfig(retained);
        setState({ ...next, config: retained, detection });
      } else {
        setState({ ...next, detection });
      }
    });
  const restoreOpenedProject = async () => {
    restoredFolder.current = '';
    openFilesRef.current = [];
    activePathRef.current = '';
    setOpenFiles([]);
    setOpenTools([]);
    previewPathRef.current = '';
    setPreviewPath('');
    setShowHome(false);
    setActivePath('');
    setView('code');
    await refresh();
    setStale(false);
  };
  const openProjectWith = (select: () => Promise<boolean>) =>
    perform('action.open', async () => {
      if (state?.workspaceOpen && (dirty || configDirty)) throw new Error('project.openWarning');
      if (await select()) await restoreOpenedProject();
    });
  const openProject = () => openProjectWith(() => window.blode.selectProject());
  const openProjectMarker = () => openProjectWith(() => window.blode.selectProjectMarker());
  const reopenProject = () =>
    perform('action.open', async () => {
      if (state?.workspaceOpen && (dirty || configDirty)) throw new Error('project.openWarning');
      const result = await window.blode.reopenProject();
      if (result.status === 'missing') {
        setRecentMissing(result.recent ?? null);
        return;
      }
      if (result.status === 'none') {
        notify(t('error.noRecentProject'), true);
        return;
      }
      setRecentMissing(null);
      await restoreOpenedProject();
    });
  const openRecentProject = (path: string) =>
    perform('action.open', async () => {
      if (state?.workspaceOpen && (dirty || configDirty)) throw new Error('project.openWarning');
      const result = await window.blode.openRecentProject(path);
      if (result.status === 'missing') {
        setRecentMissing(result.recent ?? null);
        return;
      }
      if (result.status === 'opened') await restoreOpenedProject();
    });
  const removeRecentProject = (path: string) =>
    perform('welcome.removeRecent', async () => {
      const pending = configDirty ? config : null;
      await window.blode.removeRecentProject(path);
      await refresh();
      if (pending) setConfig(pending);
    });
  const goHome = () => {
    setShowHome(true);
    setView('code');
    const pending = configDirty ? config : null;
    void refresh()
      .then(() => {
        if (pending) setConfig(pending);
      })
      .catch((error) => notify(String(error), true));
  };
  const returnToProject = () => setShowHome(false);
  const closeProject = (saveChanges: boolean) =>
    perform('project.close', async () => {
      if (saveChanges) {
        await saveFiles();
        if (config && configDirty) await window.blode.saveConfig(config);
      }
      await window.blode.closeProject();
      setCloseProjectPending(false);
      await restoreOpenedProject();
      setShowHome(true);
    });
  const install = () =>
    perform('action.install', async () => {
      setTab('output');
      if (state?.workspaceOpen && config && configDirty) await window.blode.saveConfig(config);
      await window.blode.installToolchain();
      await refresh();
      notify(t('toast.installed'));
    });
  const installDriver = (id: DriverId) =>
    perform('action.installDriver', async () => {
      setTab('output');
      await window.blode.installDriver(id);
      await refresh();
      notify(t('toast.driverInstalled'));
    });
  const refreshDrivers = () =>
    perform('action.refresh', async () => {
      const drivers = await window.blode.refreshDrivers();
      setState((current) => (current ? { ...current, drivers } : current));
    });
  const serialToggle = () =>
    perform('device.serial', async () => {
      if (serialConnected) {
        await window.blode.serialClose();
        setSerialConnected(false);
        notify(t('toast.disconnected'));
      } else {
        if (!config?.port) throw new Error('toast.noPort');
        await window.blode.serialOpen(config.port, serialBaud, serialOptions);
        setSerialConnected(true);
        notify(t('toast.connected'));
      }
    });
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(t('toast.copied'));
    } catch (error) {
      notify(String(error), true);
    }
  };
  const reportWarning = (message: string) => {
    notify(t(message), false, true);
    setLogs((current) => [
      ...current.slice(-999),
      { kind: 'log', level: 'warning', message, time: new Date().toISOString() },
    ]);
    setTab('warnings');
  };
  const pinFile = (path: string) => {
    const next = pinFileTab({ files: openFilesRef.current, preview: previewPathRef.current }, path);
    openFilesRef.current = next.files;
    previewPathRef.current = next.preview;
    setOpenFiles(next.files);
    setPreviewPath(next.preview);
  };
  const openFile = (path: string) => {
    const next = previewFile({ files: openFilesRef.current, preview: previewPathRef.current }, path);
    openFilesRef.current = next.files;
    previewPathRef.current = next.preview;
    setOpenFiles(next.files);
    setPreviewPath(next.preview);
    setShowHome(false);
    activePathRef.current = path;
    setActivePath(path);
    setView('code');
  };
  const closeTab = (kind: 'file' | 'tool', id: string) => {
    if (kind === 'file') {
      if (previewPathRef.current === id) {
        previewPathRef.current = '';
        setPreviewPath('');
      }
      const index = openFiles.indexOf(id);
      const next = openFiles.filter((path) => path !== id);
      openFilesRef.current = next;
      setOpenFiles(next);
      if (activePath === id) {
        const nextActive = next[index] ?? next[index - 1] ?? next[0] ?? '';
        activePathRef.current = nextActive;
        setActivePath(nextActive);
      }
      return;
    }
    const tool = id as ToolTab;
    setOpenTools((current) => current.filter((item) => item !== tool));
    if (view === toolTabViews[tool]) setView('code');
  };
  const editorCommand = (command: 'undo' | 'redo' | 'find' | 'format' | 'gotoLine' | 'selectAll') => {
    setView('code');
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent('blode:editor-command', { detail: command })),
    );
  };
  const resize = (which: 'left' | 'right' | 'bottom', event: React.PointerEvent) => {
    const startX = event.clientX,
      startY = event.clientY,
      start = widths[which];
    event.currentTarget.setPointerCapture(event.pointerId);
    const element = event.currentTarget;
    const move = (e: Event) => {
      const pointer = e as PointerEvent;
      const value =
        start +
        (which === 'left'
          ? pointer.clientX - startX
          : which === 'right'
            ? startX - pointer.clientX
            : startY - pointer.clientY);
      setWidths((current) => ({
        ...current,
        [which]: Math.max(which === 'bottom' ? 120 : 180, Math.min(which === 'bottom' ? 420 : 390, value)),
      }));
    };
    const end = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', end);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end);
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        build();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  return {
    t,
    locale,
    state,
    setState,
    config,
    setConfig,
    drafts,
    setDrafts,
    activePath,
    setActivePath,
    openFiles,
    openTools,
    previewPath,
    pinFile,
    showHome,
    goHome,
    returnToProject,
    closeProjectPending,
    setCloseProjectPending,
    closeProject,
    openRecentProject,
    removeRecentProject,
    openFile,
    closeTab,
    view,
    setView: (next: View) => {
      setShowHome(false);
      setView(next);
    },
    logs,
    installation,
    setLogs,
    busy,
    toast,
    setToast,
    tab,
    setTab,
    serialConnected,
    serialInput,
    setSerialInput,
    serialBaud,
    setSerialBaud,
    serialOptions,
    setSerialOptions,
    deleteTarget,
    setDeleteTarget,
    probeFailure,
    setProbeFailure,
    recentMissing,
    setRecentMissing,
    downloadProbeLog,
    sendProbeFeedback,
    chooseBoardManually,
    syncDrafts,
    setSyncDrafts,
    isWeb,
    confirmFlash,
    setConfirmFlash,
    stale,
    setStale,
    widths,
    devicePanelVisible,
    setDevicePanelVisible,
    logEnd,
    dirty,
    configDirty,
    source,
    content,
    lines,
    comments,
    longLines,
    errors,
    warnings,
    board,
    isStm32,
    isAuto,
    usesStlink,
    validatesFirmware,
    hasBuildEntry,
    notify,
    refresh,
    perform,
    save,
    saveConfig,
    setBuildEntry,
    renamePath,
    removeEntry,
    build,
    flash,
    probe,
    refreshPorts,
    refreshDebugProbes,
    refreshAutoDevices,
    openProject,
    openProjectMarker,
    reopenProject,
    install,
    installDriver,
    refreshDrivers,
    serialToggle,
    copy,
    editorCommand,
    resize,
  };
}

export type Studio = ReturnType<typeof useStudio>;
