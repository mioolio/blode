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
import { previewFile, pinFileTab, persistentFiles, readSession, sessionKey, type ToolTab } from './tabs';
import { diagnosticLevel } from './diagnostics';
import { usePanelVisibility } from './usePanelVisibility';
import { flushCollaboration } from './collaborationFlush';
import { mergeRecentLogs } from '../../shared/recent-logs';
import { useFileTabClose, type SharedCloseSource } from './useFileTabClose';
import { closeRecoveryKey, recoverCloseDrafts, workspaceCloseGate } from './workspaceCloseGate';
import { refreshedConfig } from './unsavedChanges';
import { openableFilePaths } from '../../shared/file-views';
import type { WorkspaceConsoleTabId, WorkspaceSyncTarget } from '../../shared/workspace-surfaces';
import { publishSharedSurface, requestSharedTabClose } from './sharedTabs';

type View = 'code' | 'layout' | 'ai';
type ConsoleTab = WorkspaceConsoleTabId;

const toolTabViews: Record<ToolTab, View> = { layout: 'layout', ai: 'ai' };

function viewFromRoute(route: WorkspaceRoute): View {
  if (route.kind === 'layout') return 'layout';
  if (route.kind === 'automation') return 'ai';
  return 'code';
}

function initialToolTabs(route: WorkspaceRoute): ToolTab[] {
  const routeTool: ToolTab | null =
    route.kind === 'layout' ? 'layout' : route.kind === 'automation' ? 'ai' : null;
  return routeTool ? [routeTool] : [];
}

function retainDraftConfig(pending: ProjectConfig, next: AppState): ProjectConfig {
  // The first desktop snapshot deliberately precedes hardware enumeration.
  // An empty loading list is not evidence that a saved connector disappeared.
  if (next.initializing) return pending;
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

export function useStudio() {
  const { t, locale } = useI18n();
  const route = useRef<WorkspaceRoute | null>(null);
  if (!route.current) route.current = parseWorkspaceRoute();
  const initial = route.current;
  const [state, setState] = useState<AppState | null>(null);
  const canonicalState = useRef(state);
  canonicalState.current = state;
  const refreshSequence = useRef(0);
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
  const [devicePanelVisible, setDevicePanelVisible] = usePanelVisibility('blode.devicePanel');
  const [consolePanelVisible, setConsolePanelVisible] = usePanelVisibility('blode.consolePanel');
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);
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
  const selectedBoard = state?.boards.find((item) => item.id === config?.boardId);
  const hiddenCapabilities = new Set([
    ...(selectedBoard?.runtimePlugin?.ui.hiddenCapabilities ?? []),
    ...(config?.runtime?.disabledCapabilities ?? []),
  ]);
  const board = selectedBoard
    ? {
        ...selectedBoard,
        capabilities: selectedBoard.capabilities.filter((capability) => !hiddenCapabilities.has(capability)),
      }
    : undefined;
  const isStm32 = config?.boardId === 'STM32F103C8T6';
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
  const refresh = useCallback(async (submittedConfig?: ProjectConfig) => {
    const sequence = ++refreshSequence.current;
    const next = await window.blode.getState();
    if (sequence !== refreshSequence.current) return canonicalState.current ?? next;
    if (!window.__blodeWeb && next.projectRoot) {
      try {
        if (localStorage.getItem(closeRecoveryKey(next.projectRoot))) {
          const lifecycle = await window.blode.desktopLifecycleState();
          recoverCloseDrafts(next.projectRoot, lifecycle.lifecycleId ?? '', localStorage);
        }
      } catch {
        /* Retain the recovery record if the host is still starting. */
      }
    }
    if (sequence !== refreshSequence.current) return canonicalState.current ?? next;
    const previous = canonicalState.current;
    setState(next);
    if (next.recentLogs)
      setLogs((current) =>
        mergeRecentLogs(
          current,
          next.recentLogs!.map((event) =>
            event.level === 'error' ? { ...event, level: diagnosticLevel(event.message) } : event,
          ),
        ),
      );
    setInstallation(next.installation);
    setSerialConnected(!!next.connections?.serial.open);
    setConfig((current) => {
      const retained = refreshedConfig(current, previous, next, submittedConfig);
      return retained === current ? retainDraftConfig(retained, next) : retained;
    });
    setStale(next.buildStale ?? false);
    const availablePaths = new Set(openableFilePaths(next));
    const exists = (path: string) => availablePaths.has(path);
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
  const refreshedInstallation = useRef('');
  useEffect(() => {
    if (!installation || installation.status === 'running' || busy) return;
    const revision = `${installation.id}:${installation.status}`;
    if (refreshedInstallation.current === revision) return;
    refreshedInstallation.current = revision;
    void refresh().catch((error) => notify(String(error), true));
  }, [installation?.id, installation?.status, busy, refresh, notify]);
  useEffect(() => {
    if (!state?.projectRoot || restoredFolder.current !== state.projectRoot) return;
    if (!workspaceCloseGate.canPersistDrafts(state.projectRoot)) return;
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
      if (event.kind === 'terminal' && !event.message) return;
      if (event.message === 'status.buildStarted') {
        setConsolePanelVisible(true);
        setTab('output');
      }
      const classified =
        event.level === 'error' ? { ...event, level: diagnosticLevel(event.message) } : event;
      setLogs((current) => mergeRecentLogs(current, [classified]));
      if (event.message === 'status.serialDisconnected') setSerialConnected(false);
      if (event.message === 'status.serialConnected') setSerialConnected(true);
    });
  }, [refresh, notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  // Refresh host changes while retaining drafts; collaboration resolves disk conflicts separately.
  useEffect(() => {
    if (!window.blode) return;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = window.blode.onEvent((event) => {
      if (
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
        void refresh()
          .then(() => {
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
  }, [refresh, notify]);

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
    const root = state?.projectRoot;
    if (!root) throw new Error('error.noWorkspace');
    const sameRoot = () => canonicalState.current?.projectRoot === root;
    if (!sameRoot()) throw new Error('error.collaborationProjectChanged');
    const snapshot = { ...drafts, ...(await flushCollaboration()) };
    if (!sameRoot()) throw new Error('error.collaborationProjectChanged');
    const saved = state?.files ?? [];
    for (const [path, value] of Object.entries(snapshot)) {
      if (!sameRoot()) throw new Error('error.collaborationProjectChanged');
      if (value !== saved.find((file) => file.path === path)?.content)
        await window.blode.saveFile(path, value, root);
    }
    if (!sameRoot()) throw new Error('error.collaborationProjectChanged');
    // Retain keystrokes entered while an asynchronous write was completing.
    setDrafts((current) =>
      sameRoot()
        ? Object.fromEntries(Object.entries(current).filter(([path, value]) => snapshot[path] !== value))
        : current,
    );
  };
  const save = () =>
    perform('action.save', async () => {
      const root = state?.projectRoot;
      if (!root) throw new Error('error.noWorkspace');
      if (activePath && state?.workspaceOpen) pinFile(activePath);
      await saveFiles();
      if (config && configDirty) {
        await window.blode.saveConfig(config, root);
        setStale(true);
      }
      const refreshed = await refresh(config && configDirty ? config : undefined);
      if ((refreshed?.projectRoot ?? canonicalState.current?.projectRoot) !== root)
        throw new Error('error.collaborationProjectChanged');
      notify(t('toast.saved'));
    });
  const saveConfig = () =>
    perform('action.apply', async () => {
      if (config) {
        const root = state?.projectRoot;
        if (!root) throw new Error('error.noWorkspace');
        await window.blode.saveConfig(config, root);
        setStale(true);
        const refreshed = await refresh(config);
        if ((refreshed?.projectRoot ?? canonicalState.current?.projectRoot) !== root)
          throw new Error('error.collaborationProjectChanged');
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
      setConsolePanelVisible(true);
      setTab('output');
      if (
        !isAuto &&
        !board?.capabilities.some((capability) => capability === 'compile' || capability === 'flash')
      )
        throw new Error('error.detectBoardFirst');
      await saveFiles();
      if (config && configDirty) await window.blode.saveConfig(config, state?.projectRoot);
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
          await window.blode.saveConfig(config, state?.projectRoot);
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
        await window.blode.saveConfig(config, state?.projectRoot);
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
        await window.blode.saveConfig(config, state?.projectRoot);
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
        if (config && configDirty) await window.blode.saveConfig(config, state?.projectRoot);
      }
      await window.blode.closeProject();
      setCloseProjectPending(false);
      await restoreOpenedProject();
      setShowHome(true);
    });
  const install = () =>
    perform('action.install', async () => {
      setTab('output');
      if (state?.workspaceOpen && config && configDirty)
        await window.blode.saveConfig(config, state?.projectRoot);
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
    window.dispatchEvent(
      new CustomEvent('blode:file-opened', { detail: { root: state?.projectRoot ?? '', path } }),
    );
  };
  const fileTabClose = useFileTabClose({
    state,
    drafts,
    setState,
    setDrafts,
    failed: (error) => notify(t(messageOf(error)), true),
    close: (id) => {
      if (previewPathRef.current === id) {
        previewPathRef.current = '';
        setPreviewPath('');
      }
      const index = openFilesRef.current.indexOf(id);
      openFilesRef.current = openFilesRef.current.filter((path) => path !== id);
      // Compose concurrent close commits against React's latest list, never a delayed effect's ref.
      setOpenFiles((current) => {
        const next = current.filter((path) => path !== id);
        openFilesRef.current = next;
        return next;
      });
      setActivePath((current) => {
        if (current !== id) return current;
        const remaining = openFilesRef.current.filter((path) => path !== id);
        const nextActive = remaining[index] ?? remaining[index - 1] ?? remaining[0] ?? '';
        activePathRef.current = nextActive;
        return nextActive;
      });
    },
  });
  const closeLocalTab = (kind: 'file' | 'tool', id: string): Promise<boolean> => {
    if (kind === 'file') return fileTabClose.requestFileClose(id);
    const tool = id as ToolTab;
    setOpenTools((current) => current.filter((item) => item !== tool));
    window.dispatchEvent(
      new CustomEvent('blode:tool-closed', { detail: { root: state?.projectRoot ?? '', id: tool } }),
    );
    if (view === toolTabViews[tool]) setView('code');
    return Promise.resolve(true);
  };
  const applySharedSurface = (target: WorkspaceSyncTarget, open: boolean) => {
    if (target.kind === 'panel') {
      if (target.id === 'console') setConsolePanelVisible(open);
      if (target.id === 'device') setDevicePanelVisible(open);
      if (target.id === 'runtime') setRuntimeExpanded(open);
    } else if (target.kind === 'console' && open) {
      setTab(target.id as ConsoleTab);
      setConsolePanelVisible(true);
    } else if (target.kind === 'tool') {
      // Remote tool opens are suggestions owned by the publishing peer, not local tab claims.
      if (!open) void closeLocalTab('tool', target.id);
    }
  };
  const closeTab = (kind: 'file' | 'tool', id: string): Promise<boolean> =>
    requestSharedTabClose({ kind, id }, () => closeLocalTab(kind, id));
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
      if (workspaceCloseGate.isFrozen()) return;
      if (fileTabClose.closeFilePrompt) {
        if ((event.ctrlKey || event.metaKey) && ['s', 'w', 'b', 'f4'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          if (event.key.toLowerCase() === 's') void fileTabClose.chooseFileClose('save');
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        build();
      }
      if (
        ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'w') ||
        (event.ctrlKey && event.key === 'F4')
      ) {
        if (activePathRef.current && viewRef.current === 'code') {
          event.preventDefault();
          void closeTab('file', activePathRef.current);
        }
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
    setConfig: (value: React.SetStateAction<ProjectConfig | null>) => {
      if (!workspaceCloseGate.isFrozen()) setConfig(value);
    },
    drafts,
    setDrafts: (value: React.SetStateAction<Record<string, string>>) => {
      if (!workspaceCloseGate.isFrozen())
        setDrafts((current) => {
          const next = typeof value === 'function' ? value(current) : value;
          if (!fileTabClose.frozenPaths.size) return next;
          const retained = { ...next };
          for (const path of fileTabClose.frozenPaths) {
            if (current[path] === undefined) delete retained[path];
            else retained[path] = current[path];
          }
          return retained;
        });
    },
    setSharedDrafts: (value: React.SetStateAction<Record<string, string>>) => {
      setDrafts((current) =>
        workspaceCloseGate.canApplySharedDrafts()
          ? typeof value === 'function'
            ? value(current)
            : value
          : current,
      );
    },
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
    frozenFilePaths: fileTabClose.frozenPaths,
    prepareSharedTabClose: (target: WorkspaceSyncTarget, requestId: string, source?: SharedCloseSource) =>
      target.kind === 'file'
        ? fileTabClose.prepareShared(target.id, requestId, source)
        : Promise.resolve(true),
    preparedSharedTabContent: (path: string, requestId: string) =>
      fileTabClose.preparedShared(path, requestId)?.content,
    preparedSharedTabDecision: (path: string, requestId: string) =>
      fileTabClose.preparedShared(path, requestId)?.decision,
    commitSharedTabClose: async (target: WorkspaceSyncTarget, requestId: string) => {
      if (target.kind === 'file') return fileTabClose.commitShared(target.id, requestId);
      if (target.kind === 'tool') return closeLocalTab('tool', target.id);
      applySharedSurface(target.kind === 'console' ? { kind: 'panel', id: 'console' } : target, false);
      return true;
    },
    abortSharedTabClose: (target: WorkspaceSyncTarget, requestId: string) => {
      if (target.kind === 'file') fileTabClose.abortShared(target.id, requestId);
    },
    applySharedSurface,
    closeFilePrompt: fileTabClose.closeFilePrompt,
    chooseFileClose: fileTabClose.chooseFileClose,
    view,
    setView: (next: View) => {
      setShowHome(false);
      if (next !== 'code') setOpenTools((current) => (current.includes(next) ? current : [...current, next]));
      setView(next);
    },
    logs,
    installation,
    setLogs,
    busy,
    toast,
    setToast,
    tab,
    setTab: (next: ConsoleTab) => {
      setConsolePanelVisible(true);
      setTab(next);
      publishSharedSurface({ kind: 'console', id: next }, true);
      publishSharedSurface({ kind: 'panel', id: 'console' }, true);
    },
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
    setDevicePanelVisible: (open: boolean) => {
      setDevicePanelVisible(open);
      publishSharedSurface({ kind: 'panel', id: 'device' }, open);
    },
    consolePanelVisible,
    setConsolePanelVisible: (open: boolean) => {
      setConsolePanelVisible(open);
      publishSharedSurface({ kind: 'panel', id: 'console' }, open);
    },
    runtimeExpanded,
    setRuntimeExpanded: (open: boolean) => {
      setRuntimeExpanded(open);
      publishSharedSurface({ kind: 'panel', id: 'runtime' }, open);
    },
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
