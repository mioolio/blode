import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, LogEvent, ProjectConfig } from '../../shared/contracts';
import { useI18n } from '../i18n';
import { bytes } from '../utils';
import { parseWorkspaceRoute, workspaceRouteHash, type WorkspaceRoute } from './routes';

type View = 'code' | 'layout' | 'ai' | 'settings';
type ToolTab = 'layout' | 'ai' | 'settings';
type ConsoleTab = 'output' | 'serial' | 'problems';

const toolTabViews: Record<ToolTab, View> = { layout: 'layout', ai: 'ai', settings: 'settings' };

function viewFromRoute(route: WorkspaceRoute): View {
  if (route.kind === 'layout') return 'layout';
  if (route.kind === 'automation') return 'ai';
  if (route.kind === 'settings') return 'settings';
  return 'code';
}

const isToolTab = (value: unknown): value is ToolTab =>
  value === 'layout' || value === 'ai' || value === 'settings';

function initialToolTabs(route: WorkspaceRoute): ToolTab[] {
  const routeTool: ToolTab | null =
    route.kind === 'layout'
      ? 'layout'
      : route.kind === 'automation'
        ? 'ai'
        : route.kind === 'settings'
          ? 'settings'
          : null;
  return routeTool ? [routeTool] : [];
}

interface StoredSession {
  openFiles: string[];
  openTools: ToolTab[];
  activePath: string;
}

const sessionKey = (root: string) => `blode.session:${root}`;

/** Electron wraps IPC failures; keep the protocol key so the UI can translate it. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Read the size reported by esptool; missing output leaves the configured value alone. */
function detectedFlashSize(output: string): number | null {
  const match = output.match(/(?:Detected flash size|Flash size)\s*:\s*([\d.]+)\s*MB/i);
  if (!match) return null;
  const size = Number(match[1]) * 1024 * 1024;
  return Number.isFinite(size) && size > 0 ? Math.round(size) : null;
}

/** Per-project tab state survives reloads; missing or corrupt data means a fresh start. */
function readSession(root: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(root));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    return {
      openFiles: Array.isArray(parsed.openFiles)
        ? parsed.openFiles.filter((value): value is string => typeof value === 'string')
        : [],
      openTools: Array.isArray(parsed.openTools) ? parsed.openTools.filter(isToolTab) : [],
      activePath: typeof parsed.activePath === 'string' ? parsed.activePath : '',
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
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [tab, setTab] = useState<ConsoleTab>('output');
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialInput, setSerialInput] = useState('');
  const [serialBaud, setSerialBaud] = useState(115200);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [probeFailure, setProbeFailure] = useState<{ message: string } | null>(null);
  const [syncDrafts, setSyncDrafts] = useState(() => localStorage.getItem('blode.sync') !== 'off');
  const isWeb = window.__blodeWeb === true;
  const [confirmFlash, setConfirmFlash] = useState(false);
  const [stale, setStale] = useState(false);
  const [widths, setWidths] = useState({ left: 224, right: 284, bottom: 207 });
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

  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const refresh = useCallback(async () => {
    const next = await window.blode.getState();
    setState(next);
    setConfig(next.config);
    setStale(next.buildStale ?? false);
    const exists = (path: string) => next.files.some((file) => file.path === path);
    if (restoredFolder.current !== next.projectRoot) {
      restoredFolder.current = next.projectRoot;
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`blode.drafts:${next.projectRoot}`) ?? '{}');
        const editable = new Map(next.files.map((file) => [file.path, file.content]));
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
        if (current && exists(current) && !nextOpen.includes(current))
          nextOpen = [...nextOpen, current];
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
      const restoredTools = session ? session.openTools : [];
      const activeTool = viewRef.current === 'code' ? null : (viewRef.current as ToolTab);
      const nextTools =
        activeTool && !restoredTools.includes(activeTool) ? [...restoredTools, activeTool] : restoredTools;
      openFilesRef.current = nextOpen;
      activePathRef.current = nextActive;
      setOpenFiles(nextOpen);
      setActivePath(nextActive);
      setOpenTools(nextTools);
      return next;
    }
    const nextOpen = openFilesRef.current.filter(exists);
    const nextActive =
      activePathRef.current && exists(activePathRef.current)
        ? activePathRef.current
        : (nextOpen[0] ?? '');
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
    const root = state?.projectRoot;
    if (!root || restoredFolder.current !== root) return;
    try {
      localStorage.setItem(sessionKey(root), JSON.stringify({ openFiles, openTools, activePath }));
    } catch {
      /* Tab state is optional. */
    }
  }, [state?.projectRoot, openFiles, openTools, activePath]);
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
          : view === 'settings'
            ? { kind: 'settings' }
            : { kind: 'editor', ...(activePath ? { file: activePath } : {}) };
    const hash = workspaceRouteHash(route);
    if (window.location.hash !== hash) {
      try {
        window.history.replaceState(null, '', hash);
      } catch {
        /* A restricted host may reject history updates; navigation still works. */
      }
    }
  }, [view, activePath]);
  useEffect(() => {
    if (!window.blode) {
      notify(t('toast.desktop'), true);
      return;
    }
    void refresh().catch((error) => notify(String(error), true));
    return window.blode.onEvent((event) => {
      setLogs((current) => [...current.slice(-999), event]);
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
          'status.buildSucceeded',
          'status.buildFailed',
          'status.projectOpened',
          'status.workspaceChanged',
        ].includes(event.message)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void window.blode
          .getState()
          .then((next) => {
            setState(next);
            if (!configDirty) setConfig(next.config);
            setStale(next.buildStale ?? false);
            if (event.message === 'status.fileSaved' || event.message === 'status.configSaved')
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
      notify(t(message), true);
      setLogs((current) => [
        ...current.slice(-999),
        { kind: 'log', level: 'error', message, time: new Date().toISOString() },
      ]);
      setTab('output');
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
    perform('action.build', async () => {
      setTab('output');
      await saveFiles();
      if (config && configDirty) await window.blode.saveConfig(config);
      const result = await window.blode.build();
      await refresh();
      setStale(!result.success);
      if (result.success) notify(t('toast.built'));
    });
  const flash = () => {
    if (!config?.port) {
      notify(t('toast.noPort'), true);
      return;
    }
    if (!state?.lastBuild?.success || state.buildStale || stale || dirty || configDirty) {
      notify(t('toast.noBuild'), true);
      return;
    }
    setConfirmFlash(true);
  };
  const probe = () =>
    perform('action.probe', async () => {
      if (!config?.port) throw new Error('toast.noPort');
      setTab('output');
      const boardBefore = config.boardId;
      try {
        const output = await window.blode.probe(config.port);
        if (boardBefore !== 'auto') {
          // A manually selected board keeps its layout; only the measured capacity changes.
          const detected = detectedFlashSize(output);
          if (detected && detected !== config.flashSize) {
            const updated = { ...config, flashSize: detected };
            await window.blode.saveConfig(updated);
            setConfig(updated);
            setStale(true);
            notify(`${t('toast.flashDetected')} ${bytes(detected)}`);
          }
          return;
        }
        // The core promotes the detected chip to a registered adapter and persists its layout.
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
      `port: ${config?.port ?? ''}`,
      '',
      ...logs.map((event) => `${event.time} [${event.level}] ${event.message}`),
    ].join('\n');
  const downloadProbeLog = () => {
    const url = URL.createObjectURL(new Blob([probeLog()], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `blode-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(t('toast.logDownloaded'));
  };
  const sendProbeFeedback = async () => {
    try {
      await navigator.clipboard.writeText(
        `${probeLog()}\n\nhttps://github.com/mioolio/blode/issues/new`,
      );
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
    });
  const openProjectWith = (select: () => Promise<boolean>) =>
    perform('action.open', async () => {
      if (dirty || configDirty) throw new Error('project.openWarning');
      if (await select()) {
        restoredFolder.current = '';
        openFilesRef.current = [];
        activePathRef.current = '';
        setOpenFiles([]);
        setOpenTools([]);
        setActivePath('');
        setView('code');
        await refresh();
        setStale(false);
        setSerialConnected(false);
      }
    });
  const openProject = () => openProjectWith(() => window.blode.selectProject());
  const openProjectMarker = () => openProjectWith(() => window.blode.selectProjectMarker());
  const install = () =>
    perform('action.install', async () => {
      setTab('output');
      if (config && configDirty) await window.blode.saveConfig(config);
      await window.blode.installToolchain();
      await refresh();
      notify(t('toast.installed'));
    });
  const serialToggle = () =>
    perform('device.serial', async () => {
      if (serialConnected) {
        await window.blode.serialClose();
        setSerialConnected(false);
        notify(t('toast.disconnected'));
      } else {
        if (!config?.port) throw new Error('toast.noPort');
        await window.blode.serialOpen(config.port, serialBaud);
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
  const openFile = (path: string) => {
    setOpenFiles((current) => {
      const next = current.includes(path) ? current : [...current, path];
      openFilesRef.current = next;
      return next;
    });
    activePathRef.current = path;
    setActivePath(path);
    setView('code');
  };
  const closeTab = (kind: 'file' | 'tool', id: string) => {
    if (kind === 'file') {
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
    openFile,
    closeTab,
    view,
    setView,
    logs,
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
    deleteTarget,
    setDeleteTarget,
    probeFailure,
    setProbeFailure,
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
    notify,
    refresh,
    perform,
    save,
    saveConfig,
    renamePath,
    removeEntry,
    build,
    flash,
    probe,
    refreshPorts,
    openProject,
    openProjectMarker,
    install,
    serialToggle,
    copy,
    editorCommand,
    resize,
  };
}

export type Studio = ReturnType<typeof useStudio>;
