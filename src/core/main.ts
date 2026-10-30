import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
} from 'electron';
import { appendFileSync, mkdirSync, promises as fs, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { createCore, type CoreService } from './service';
import { listBoards } from '../../extensions/registry';
import { startPipeServer, type PipeServerHandle } from '../automation/server';
import {
  EVENT_CHANNEL,
  IPC_CHANNEL,
  RENDERER_READY_CHANNEL,
  type LogEvent,
  type RecentProject,
  type ReopenProjectResult,
} from '../shared/contracts';
import { loadAppConfig, installDebugControls } from './debug';
import { parseConfig, configSchema, debuggerSettingsRequestSchema } from './config';
import { isDebuggerWindowMethod } from './debugger-window-access';
import { PROJECT_MARKER, safeWorkspacePath } from './workspace';
import { startWebServer, type WebServerHandle } from './web';
import { exportProbeLog } from './log-export';
import { MAX_PROBE_LOG_BYTES } from '../shared/probe-log';
import { RecentProjects } from './recent-projects';
import { FirmwareStore, prepareBuildExport } from './firmware';
import { HardwareDebugger } from './hardware-debugger';
import { RuntimeDebugger } from './runtime-debugger';
import {
  breakpointLocationsSchema,
  debuggerPatchSchema,
  debuggerAssembleSchema,
} from '../shared/debugger-edit';
import { RuntimeWindows } from './runtime-windows';
import { DesktopLifecycle } from './desktop-lifecycle';
import { currentRendererFrame, sendToRenderer } from './renderer-delivery';
import { IPC_CANCELLED, withIpcCancellation } from '../shared/ipc-response';
import { isRuntimeViewKind } from '../shared/plugins';
import { createWebDebugger } from './web-debugger';
import { resolveBuildDebugSymbols } from './build-debug-symbols';
import { AiAssistance } from './ai-assistance';
import { CollaborationService } from './collaboration';
import { createAssistanceRoutes } from './assistance-routes';
import { NativePresenceOwner } from './native-presence';
import { UiCommands } from './ui-commands';
import { RecentLogs } from './recent-logs';
import { createWorkbenchAutomation } from './workbench-automation';
import { COLLABORATION_CHANNEL, UI_COMMAND_CHANNEL } from '../shared/contracts';
import { createHostServices, type HostServices } from './host-services';
import { packageWindowMethodAllowed } from './secondary-window-access';
import { developmentRendererUrl } from '../shared/development-url';
import { generalExtensionPanelKey } from '../shared/general-extensions';
import { protectSharedWorkspace } from './shared-workspace';
import { RELEASE_VERSION } from '../shared/version';
import { renderRuntimeView, RUNTIME_VIEW_CSP } from '../shared/runtime-view';
import { workspaceAssetRequestSchema } from './workspace-assets';

protocol.registerSchemesAsPrivileged([
  { scheme: 'blode-runtime-ui', privileges: { standard: true, secure: true } },
  { scheme: 'blode-extension-ui', privileges: { standard: true, secure: true } },
  {
    scheme: 'blode-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

app.setName('Blode Studio');
// Keep drafts in Local Storage, but avoid persistent GPU/Dawn cache handles.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  // Graphite has its own persistent cache, independent of the shader-cache flag.
  if (process.platform === 'win32') app.commandLine.appendSwitch('disable-skia-graphite');
  const disabled = app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean);
  app.commandLine.appendSwitch(
    'disable-features',
    [...new Set([...disabled, 'GpuPersistentCache', 'SkiaGraphiteUsePersistentCache'])].join(','),
  );
}
// The Windows development shell must remain usable with problematic GPU drivers.
// Explicit 0 opts back into hardware rendering for diagnostics.
if (
  process.env.BLODE_DISABLE_GPU === '1' ||
  (!app.isPackaged && process.platform === 'win32' && process.env.BLODE_DISABLE_GPU !== '0')
)
  app.disableHardwareAcceleration();
// Development launches pass a workspace log so early exits leave a readable trace.
const devLogFile = process.env.BLODE_DEV_LOG;
const bootStarted = performance.now();
function logBoot(message: string): void {
  if (!devLogFile) return;
  try {
    appendFileSync(
      devLogFile,
      `${new Date().toISOString()} ${message} elapsed=${Math.round(performance.now() - bootStarted)}ms\n`,
      'utf8',
    );
  } catch {
    /* A broken diagnostic log must never block startup. */
  }
}
logBoot(
  `start pid=${process.pid} version=${RELEASE_VERSION} packaged=${app.isPackaged} electron=${process.versions.electron}`,
);
// Configure and check the path in Electron itself: the parent Node process may
// have broader filesystem access than the desktop process.
if (!app.isPackaged && process.env.BLODE_DEV_USER_DATA) {
  try {
    const userData = path.resolve(process.env.BLODE_DEV_USER_DATA);
    mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
    app.setPath('sessionData', userData);
    const probe = path.join(userData, `.write-probe-${process.pid}`);
    writeFileSync(probe, '', { flag: 'wx' });
    unlinkSync(probe);
    logBoot(`userData writable ${userData}`);
  } catch (error) {
    logBoot(`fatal userData is not writable: ${String(error)}`);
    console.error('Blode Studio development user data is not writable:', error);
    app.exit(1);
  }
}
// Follow the operating system theme; the renderer reads the same preference via CSS.
nativeTheme.themeSource = 'system';
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#0b0e14' : '#eef1f6');
const windowActionArgs = z.tuple([z.enum(['minimize', 'maximize', 'close'])]);
function controlWindow(target: BrowserWindow | null, action: 'minimize' | 'maximize' | 'close') {
  if (!target || target.isDestroyed()) return;
  if (action === 'minimize') target.minimize();
  else if (action === 'maximize') {
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
  } else target.close();
}
let window: BrowserWindow | null = null;
let core: CoreService | null = null;
let pipe: PipeServerHandle | null = null;
let web: WebServerHandle | null = null;
let closing = false;
let debuggerWindow: BrowserWindow | null = null;
let hardwareDebugger: HardwareDebugger | null = null;
let collaboration: CollaborationService | undefined;
let uiCommands: UiCommands | undefined;
let hostServices: HostServices | undefined;
let runtimeWindows: RuntimeWindows | undefined;
let desktopLifecycle: DesktopLifecycle | undefined;
let rendererMounted = false;
const terminalFocus = new Set<number>();
const allowReleaseLink = ({ url }: { url: string }) => {
  try {
    const link = new URL(url);
    if (
      link.protocol === 'https:' &&
      !link.username &&
      !link.password &&
      ((link.hostname === 'github.com' &&
        /^\/(?:xpack-dev-tools\/arm-none-eabi-gcc-xpack|arduino\/arduino-cli|espressif\/arduino-esp32|stlink-org\/stlink)\/(?:releases|blob)(?:\/|$)/.test(
          link.pathname,
        )) ||
        (link.hostname === 'espressif.github.io' &&
          link.pathname === '/arduino-esp32/package_esp32_index.json'))
    )
      void shell.openExternal(link.href).catch(() => {});
  } catch {}
  return { action: 'deny' as const };
};
const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const ownLock = app.requestSingleInstanceLock();
logBoot(`singleInstanceLock=${ownLock} userData=${app.getPath('userData')}`);
if (!ownLock) app.quit();
// A forcibly closed terminal must not leave an invisible browser holding its profile.
if (!app.isPackaged && ownLock && /^\d+$/.test(process.env.BLODE_DEV_PARENT_PID ?? '')) {
  const parentPid = Number(process.env.BLODE_DEV_PARENT_PID);
  const parentWatch = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      logBoot('development launcher exited; closing orphaned desktop');
      app.quit();
    }
  }, 1000);
  parentWatch.unref();
  process.once('disconnect', () => {
    logBoot('development launcher disconnected');
    app.quit();
  });
  app.once('will-quit', () => clearInterval(parentWatch));
}
app.on('child-process-gone', (_event, details) => {
  logBoot(`child-process-gone ${details.type} ${details.reason} exit=${details.exitCode}`);
});
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
});

/** Chip definitions live only in extensions/boards; a missing folder refuses to load. */
async function verifyBoardFolder(root: string): Promise<void> {
  const info = await fs.stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error('errors.boardsMissing');
  for (const board of listBoards()) {
    await fs.access(path.join(root, board.id, 'manifest.json')).catch(() => {
      throw new Error(`errors.boardManifestMissing: ${board.id}`);
    });
  }
}

async function bootstrap(): Promise<void> {
  logBoot(`bootstrap appPath=${app.getAppPath()} renderer=${developmentUrl ?? 'file'}`);
  const applicationConfig = await loadAppConfig(path.join(app.getAppPath(), 'config', 'application.json'));
  // Board adapters are code, but every chip model must declare itself in this folder.
  await verifyBoardFolder(
    app.isPackaged
      ? path.join(process.resourcesPath, 'boards')
      : path.join(app.getAppPath(), 'extensions', 'boards'),
  );
  logBoot('board folder verified');
  // Begin rendering while local services initialize. RPC calls wait for the same
  // validated route table, so an early frame cannot observe a half-created core.
  let nativePresence: NativePresenceOwner | undefined;
  let screenLocked = false;
  let suspended = false;
  const windowAttention = async () => {
    const visible =
      !!window &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      !screenLocked &&
      !suspended;
    const focused = visible && !!window?.isFocused();
    const epoch = await nativePresence?.setAttention(focused);
    return { visible, focused, epoch };
  };
  const publishAttention = () => {
    void windowAttention()
      .then((value) => {
        if (!closing) sendToRenderer(window, 'blode:window-attention', value);
      })
      .catch((error) => logBoot(`window-attention ${String(error)}`));
  };
  type RendererRoutes = Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }>;
  let resolveRendererRoutes!: (routes: RendererRoutes | null) => void;
  const rendererRoutes = new Promise<RendererRoutes | null>((resolve) => {
    resolveRendererRoutes = resolve;
  });
  logBoot('creating window');
  let windowShown = false;
  let rendererRecoveryUsed = false;
  window = new BrowserWindow({
    title: 'Blode Studio',
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.removeMenu();
  for (const name of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const)
    window.on(name as 'focus', publishAttention);
  const lock = () => {
    screenLocked = true;
    publishAttention();
  };
  const unlock = () => {
    screenLocked = false;
    publishAttention();
  };
  const suspend = () => {
    suspended = true;
    publishAttention();
  };
  const resume = () => {
    suspended = false;
    publishAttention();
  };
  powerMonitor.on('lock-screen', lock);
  powerMonitor.on('unlock-screen', unlock);
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('resume', resume);
  window.once('closed', () => {
    powerMonitor.removeListener('lock-screen', lock);
    powerMonitor.removeListener('unlock-screen', unlock);
    powerMonitor.removeListener('suspend', suspend);
    powerMonitor.removeListener('resume', resume);
  });
  if (process.platform === 'win32') {
    // Windows broadcasts topology changes to top-level windows. No polling of USB/SWD is needed.
    window.hookWindowMessage(0x0219, (wParam) => {
      if (closing || wParam.length < 4) return;
      const change = wParam.readUInt32LE(0);
      if (change === 0x0007 || change === 0x8000 || change === 0x8004) core?.notifyDevicesChanged();
    });
  }
  const onRendererReady = (event: Electron.IpcMainEvent) => {
    const frame = currentRendererFrame(event.sender);
    if (
      closing ||
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      !frame ||
      event.senderFrame !== frame
    )
      return;
    rendererMounted = true;
    publishAttention();
    if (windowShown) return;
    windowShown = true;
    window.show();
    logBoot('window ready interface=mounted');
    if (devLogFile && process.env.BLODE_RENDER_DIAGNOSTICS === '1') {
      void window.webContents
        .capturePage()
        .then((capture) =>
          fs.writeFile(path.join(path.dirname(devLogFile), 'dev-renderer.png'), capture.toPNG()),
        )
        .catch((error) => logBoot(`renderer-capture-error ${String(error)}`));
    }
  };
  ipcMain.on(RENDERER_READY_CHANNEL, onRendererReady);
  window.once('closed', () => ipcMain.removeListener(RENDERER_READY_CHANNEL, onRendererReady));
  window.once('closed', () => resolveRendererRoutes(null));
  window.webContents.on('console-message', (_event, ...args: unknown[]) => {
    logBoot(
      `renderer-console ${args.map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value))).join(' ')}`,
    );
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logBoot(`preload-error ${preloadPath} ${error.stack ?? error.message}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    logBoot(`did-fail-load ${code} ${description} ${url}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererMounted = false;
    terminalFocus.clear();
    void nativePresence?.clear();
    logBoot(`render-process-gone ${details.reason} exit=${details.exitCode}`);
    if (closing || !windowShown || window?.isDestroyed()) return;
    if (!rendererRecoveryUsed && details.reason !== 'clean-exit') {
      rendererRecoveryUsed = true;
      logBoot('recovering crashed renderer');
      window?.webContents.reloadIgnoringCache();
    } else app.quit();
  });
  const disposeDebugControls = installDebugControls(
    window,
    {
      ...applicationConfig.debug,
      enabled: !app.isPackaged && applicationConfig.debug.enabled,
    },
    () => closing || terminalFocus.has(window!.webContents.id) || !!desktopLifecycle?.state().pendingClose,
  );
  window.on('closed', disposeDebugControls);
  const syncWindowBackground = () => window?.setBackgroundColor(windowBackground());
  nativeTheme.on('updated', syncWindowBackground);
  window.on('closed', () => nativeTheme.off('updated', syncWindowBackground));
  window.webContents.setWindowOpenHandler(allowReleaseLink);
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      rendererMounted = false;
      terminalFocus.clear();
      void nativePresence?.clear();
    }
  });
  window.webContents.once('destroyed', () => {
    void nativePresence?.clear();
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );

  ipcMain.handle(IPC_CHANNEL, (event, method: unknown, args: unknown) =>
    withIpcCancellation(async () => {
      if (closing) return IPC_CANCELLED;
      const secondary = event.sender === debuggerWindow?.webContents;
      const runtimeOwner = runtimeWindows?.owner(event.sender);
      if (event.sender !== window?.webContents && !secondary && !runtimeOwner)
        throw new Error('error.unauthorized');
      const frame = currentRendererFrame(event.sender);
      if (!frame) return IPC_CANCELLED;
      if (event.senderFrame !== frame) throw new Error('error.unauthorized');
      if (runtimeOwner && !packageWindowMethodAllowed(runtimeOwner, method, args))
        throw new Error('error.unauthorized');
      if (method === 'terminalFocus') {
        if (
          event.sender !== window?.webContents ||
          !Array.isArray(args) ||
          args.length !== 1 ||
          typeof args[0] !== 'boolean'
        )
          throw new Error('error.unauthorized');
        if (args[0]) terminalFocus.add(event.sender.id);
        else terminalFocus.delete(event.sender.id);
        return;
      }
      if (method === 'windowAttention') {
        if (event.sender !== window?.webContents || !Array.isArray(args) || args.length)
          throw new Error('error.unauthorized');
        return windowAttention();
      }
      if (secondary && !isDebuggerWindowMethod(method)) throw new Error('error.unauthorized');
      // Frameless controls must remain responsive even while a service is starting.
      if (method === 'windowAction') {
        const parsed = windowActionArgs.safeParse(args);
        if (!parsed.success) throw new Error('error.invalidArguments');
        controlWindow(runtimeOwner?.window ?? (secondary ? debuggerWindow : window), parsed.data[0]);
        return;
      }
      const routes = await rendererRoutes;
      if (!routes || closing || event.senderFrame !== currentRendererFrame(event.sender))
        throw new Error('error.operationCancelled');
      if (typeof method !== 'string' || !Object.hasOwn(routes, method))
        throw new Error('error.unknownMethod');
      const route = routes[method];
      const parsed = route.args.safeParse(args);
      if (!parsed.success) throw new Error('error.invalidArguments');
      return route.run(...(parsed.data as unknown[]));
    }),
  );
  window.once('ready-to-show', () => {
    // index.html already contains a themed, lightweight startup surface.
    if (closing || !window || window.isDestroyed()) return;
    window.show();
    logBoot('window first paint');
  });
  window.once('closed', () => debuggerWindow?.close());
  const loadRenderer = () => {
    if (developmentUrl) {
      return window!.loadURL(developmentRendererUrl(developmentUrl));
    }
    return window!.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  };
  const rendererLoad = loadRenderer().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const dataRoot = process.env.BLODE_DATA_ROOT || app.getPath('userData');
  runtimeWindows = new RuntimeWindows({
    preload: path.join(__dirname, 'preload.cjs'),
    rendererFile: path.join(__dirname, 'renderer', 'index.html'),
    rendererUrl: developmentUrl,
    background: windowBackground,
  });
  logBoot(`dataRoot=${dataRoot}`);
  const recentProjectFile = path.join(dataRoot, 'recent-project.json');
  const recentHistory = new RecentProjects(recentProjectFile);
  const firmwareStore = new FirmwareStore(dataRoot);
  const readRecentProject = async (): Promise<RecentProject | null> => {
    let stored = '';
    try {
      const parsed = JSON.parse(await fs.readFile(recentProjectFile, 'utf8')) as { path?: unknown };
      if (typeof parsed.path === 'string' && parsed.path) stored = path.resolve(parsed.path);
    } catch {
      return null;
    }
    if (!stored) return null;
    const directory = await fs.stat(stored).catch(() => null);
    const marker = directory?.isDirectory()
      ? await fs.stat(path.join(stored, PROJECT_MARKER)).catch(() => null)
      : null;
    return {
      path: stored,
      name: path.basename(stored),
      available: !!directory?.isDirectory() && !!marker?.isFile(),
    };
  };
  const rememberProject = async (root: string): Promise<void> => {
    await fs
      .mkdir(dataRoot, { recursive: true })
      .then(() => fs.writeFile(recentProjectFile, JSON.stringify({ path: root }), 'utf8'))
      .catch(() => {
        /* Recent-project history is optional. */
      });
  };
  // No workspace is opened on startup; the welcome screen asks for a project area.
  const projectRoot = process.env.BLODE_PROJECT_ROOT || '';
  const recentLogs = new RecentLogs();
  const emit = (input: LogEvent) => {
    const event = recentLogs.publish(input);
    if (!closing) {
      sendToRenderer(window, EVENT_CHANNEL, event);
      sendToRenderer(debuggerWindow, EVENT_CHANNEL, event);
      if (event.message === 'status.extensionsChanged') {
        runtimeWindows?.publishExtensionEvent(EVENT_CHANNEL, event);
        void hostServices?.generalExtensions
          .state()
          .then((state) =>
            runtimeWindows?.retainExtensions(
              new Set(state.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id)),
            ),
          )
          .catch(() => {});
      }
    }
    pipe?.publish(event);
    web?.publish(event);
  };
  // Electron follows the OS proxy; external Go/Python tools need its explicit environment.
  const toolchainEnv = { ...process.env };
  if (!toolchainEnv.HTTPS_PROXY && !toolchainEnv.https_proxy) {
    const resolved = await session.defaultSession.resolveProxy('https://downloads.arduino.cc');
    const proxy = resolved
      .split(';')
      .map((value) => value.trim())
      .find((value) => /^PROXY\s+[^\s]+$/.test(value));
    if (proxy) {
      const address = `http://${proxy.replace(/^PROXY\s+/, '')}`;
      toolchainEnv.HTTPS_PROXY = address;
      toolchainEnv.HTTP_PROXY ??= address;
    }
  }
  if (closing) return;
  // The full package ships a tools folder beside the app, so compilation works
  // without extra downloads. The lite package has none and installs into the
  // user data folder; an explicitly configured path always wins.
  const bundledTools = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'tools');
  const bundledToolsReady = await fs
    .stat(bundledTools)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  logBoot(`bundledTools=${bundledToolsReady} ${bundledTools}`);
  core = await createCore({
    openRuntimeView: async (pluginId, view) => {
      if (closing) throw new Error('error.operationCancelled');
      if (view.location === 'window') await runtimeWindows!.open(pluginId, view);
      else {
        if (!uiCommands) throw new Error('error.uiUnavailable');
        await uiCommands.command({ action: 'runtimeView', pluginId, viewId: view.id });
      }
    },
    pluginRoots: [path.join(app.getAppPath(), 'extensions', 'boards'), path.join(dataRoot, 'plugins')],
    projectRoot,
    dataRoot,
    onEvent: emit,
    refreshDevices: true,
    progressiveStartup: true,
    hardwareBusy: () => !!hardwareDebugger?.active,
    debuggerSerialPort: () => hardwareDebugger?.ownedSerialPort,
    toolchainEnv,
    fetcher: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    toolchainRoot: process.env.BLODE_TOOLCHAIN_ROOT || (bundledToolsReady ? bundledTools : undefined),
    // Vendor driver archives are read-only extras; extraction happens under userData.
    driverRoot:
      process.env.BLODE_DRIVER_ROOT ||
      (app.isPackaged
        ? path.join(process.resourcesPath, 'drivers', 'STSW-LINK')
        : path.join(app.getAppPath(), 'tools', 'STSW-LINK')),
  });
  if (closing) {
    await core.shutdown();
    return;
  }
  protocol.handle('blode-asset', async (request) => {
    const url = new URL(request.url);
    if (!core || closing || url.hostname !== 'workspace' || !['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 404 });
    return core.workspaceAssetResponse(
      url.pathname.slice(1),
      request.headers.get('range'),
      request.method === 'HEAD',
    );
  });
  protocol.handle('blode-runtime-ui', async (request) => {
    try {
      const url = new URL(request.url);
      const [id, kind, ...rest] = url.pathname.slice(1).split('/').map(decodeURIComponent);
      if (url.hostname !== 'view' || rest.length || !isRuntimeViewKind(kind) || !core || closing)
        return new Response('Not found', { status: 404 });
      const html = await core.runtimePlugins.view(id, kind);
      if (!html) return new Response('Not found', { status: 404 });
      return new Response(renderRuntimeView(html), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': RUNTIME_VIEW_CSP,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Runtime view unavailable', { status: 403 });
    }
  });
  protocol.handle('blode-extension-ui', async (request) => {
    try {
      const url = new URL(request.url);
      const [id, view, ...rest] = url.pathname.slice(1).split('/').map(decodeURIComponent);
      if (
        request.method !== 'GET' ||
        url.hostname !== 'view' ||
        url.search ||
        url.hash ||
        rest.length ||
        !hostServices ||
        closing
      )
        return new Response('Not found', { status: 404 });
      const html = await hostServices.invoke('generalExtensionViewDocument', [{ id, view }]);
      if (typeof html !== 'string' || html.length > 1_000_000 || closing)
        return new Response('Not found', { status: 404 });
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': RUNTIME_VIEW_CSP,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Extension view unavailable', { status: 403 });
    }
  });
  const originalSaveFile = core.saveFile.bind(core);
  collaboration = new CollaborationService({
    workspace: () => core!.workspaceSnapshot(),
    freshWorkspace: () => core!.workspaceSnapshot(true),
    saveFile: originalSaveFile,
    publish: (event) => {
      if (!closing) sendToRenderer(window, COLLABORATION_CHANNEL, event);
      web?.publishCollaboration(event);
    },
  });
  const ai = new AiAssistance({
    dataRoot,
    projectRoot: () => core!.currentProjectRoot(),
    emit,
    builtins: async () =>
      (await core?.languageConfiguration())?.entries.flatMap((entry) => entry.contributions),
  });
  uiCommands = new UiCommands((request) => {
    if (!closing) sendToRenderer(window, UI_COMMAND_CHANNEL, request);
    web?.publishUiCommand(request);
  });
  const assistance = createAssistanceRoutes(ai, collaboration, uiCommands, true);
  nativePresence = new NativePresenceOwner(collaboration);
  publishAttention();
  desktopLifecycle = new DesktopLifecycle({
    window,
    dataRoot,
    rendererCommit: true,
    rendererReady: () => rendererMounted,
    sharedDirty: async () => (await collaboration!.state()).documents.some((document) => document.dirty),
    prepareShutdown: async (decision) => {
      await collaboration!.prepareShutdown(decision);
    },
    cancelShutdown: () => collaboration!.cancelShutdown(),
    exit: shutdownApplication,
  });
  await desktopLifecycle.initialize();
  if (closing) return;
  assistance.routes.collaborationPresence.run = (input) => nativePresence!.presence(input);
  assistance.routes.collaborationLeave.run = (input) => nativePresence!.leave(input);
  assistance.routes.collaborationTabClose.run = (input) => nativePresence!.tabClose(input);
  const webAssistance = createAssistanceRoutes(ai, collaboration, uiCommands, false);
  const protection = protectSharedWorkspace(core, collaboration);
  hostServices = createHostServices({
    ai,
    extensionExamplesRoot: app.isPackaged
      ? path.join(process.resourcesPath, 'extensions', 'plugins')
      : path.join(app.getAppPath(), 'extensions', 'plugins'),
    openExtensionView: async (id, view) => runtimeWindows!.open(id, view, 'extension'),
    extensionViewUrl: (id, view) =>
      `blode-extension-ui://view/${encodeURIComponent(id)}/${encodeURIComponent(view)}`,
    openExtensionPanel: async (id, view) => {
      await uiCommands!.command({ action: 'console', tab: generalExtensionPanelKey(id, view.id) });
    },
    openRuntimeView: async (id, view) => {
      await runtimeWindows!.open(id, view);
      return { destination: 'window' };
    },
    runtimeViewDocument: (id, kind) => `blode-runtime-ui://view/${encodeURIComponent(id)}/${kind}`,
    runtimeDebugger: () => (hardwareDebugger instanceof RuntimeDebugger ? hardwareDebugger : undefined),
    core,
    collaboration,
    firmware: firmwareStore,
    recent: recentHistory,
    dataRoot,
    toolchainRoot:
      process.env.BLODE_TOOLCHAIN_ROOT ||
      (bundledToolsReady ? bundledTools : path.join(dataRoot, 'toolchains')),
    emit,
    toolchainEnv,
    fetcher: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    reloadProject: protection.reload,
    savePackage: async (file) => {
      const destination = await dialog.showSaveDialog(window!, {
        title: '打包工程 / Package project',
        defaultPath: file.name,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (destination.canceled || !destination.filePath) return false;
      await fs.copyFile(file.path, destination.filePath);
      return true;
    },
  });
  // The UI and all automation routes use the same service instance and locks.
  const state = core.getState.bind(core);
  core.getState = async () => {
    const [current, recent, shared] = await Promise.all([
      state(),
      recentHistory.list(),
      collaboration!.state(),
    ]);
    return {
      ...current,
      buildStale: current.buildStale || shared.documents.some((document) => document.dirty),
      recentLogs: recentLogs.snapshot(),
      recentProject: recent[0] ?? null,
      recentProjects: recent,
      pipe: { endpoint: pipe?.endpoint ?? '', tokenFile: pipe?.tokenFile ?? '' },
      web: {
        endpoint: web?.endpoint ?? '',
        tokenFile: web?.tokenFile ?? '',
        allowExternal: web?.allowExternal ?? false,
      },
    };
  };
  hardwareDebugger = new RuntimeDebugger(
    process.env.BLODE_TOOLCHAIN_ROOT ||
      (bundledToolsReady ? bundledTools : path.join(dataRoot, 'toolchains')),
    path.join(dataRoot, 'debugger'),
    (message) => emit({ kind: 'status', level: 'info', message, time: new Date().toISOString() }),
    () => core?.runtimePlugins,
    () => core?.currentConfig(),
    (config) => resolveBuildDebugSymbols(core!, config),
  );
  await hardwareDebugger.restore();
  if (closing) return;
  if (projectRoot) await recentHistory.remember(projectRoot).catch(() => {});
  const openDebugger = async () => {
    if (closing) throw new Error('error.operationCancelled');
    if (debuggerWindow && !debuggerWindow.isDestroyed()) {
      debuggerWindow.show();
      debuggerWindow.focus();
      return;
    }
    debuggerWindow = new BrowserWindow({
      title: 'Blode Studio · 硬件调试',
      frame: false,
      width: 1280,
      height: 850,
      minWidth: 900,
      minHeight: 650,
      backgroundColor: windowBackground(),
      show: false,
      webPreferences: {
        additionalArguments: ['--blode-frameless'],
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const secondary = debuggerWindow;
    secondary.removeMenu();
    secondary.webContents.setWindowOpenHandler(allowReleaseLink);
    secondary.webContents.on('will-navigate', (e) => e.preventDefault());
    secondary.once('ready-to-show', () => {
      if (!closing && !secondary.isDestroyed()) secondary.show();
    });
    secondary.once('closed', () => {
      debuggerWindow = null;
      void hardwareDebugger?.disconnect();
    });
    if (developmentUrl) await secondary.loadURL(developmentUrl + '/#/hardware-debugger');
    else
      await secondary.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
        hash: '/hardware-debugger',
      });
  };
  core.automationInvoke = createWorkbenchAutomation({
    core,
    ai,
    collaboration,
    debugger: hardwareDebugger,
    firmware: firmwareStore,
    recent: recentHistory,
    logs: recentLogs,
    ui: uiCommands,
    hostServices,
    openDebugger,
    windowAction: (action) => {
      if (action === 'minimize') window?.minimize();
      if (action === 'maximize' && window) {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      }
      if (action === 'close') window?.close();
    },
  });
  pipe = await startPipeServer({ api: core, dataRoot, onEvent: emit });
  if (closing) {
    await pipe.close();
    return;
  }
  logBoot(`pipe ready ${pipe.endpoint}`);
  if (applicationConfig.web.enabled) {
    try {
      web = await startWebServer({
        api: core,
        assets: (id, range, head) => core!.workspaceAssetResponse(id, range, head),
        assistance: webAssistance,
        hostServices,
        packageDownload: (id) => hostServices!.packages.download(id),
        debugger: createWebDebugger(hardwareDebugger, core),
        dataRoot,
        appRoot: app.getAppPath(),
        isPackaged: app.isPackaged,
        rendererUrl: developmentUrl,
        allowExternal: applicationConfig.web.allowExternal,
      });
      if (closing) {
        await web.close();
        return;
      }
    } catch (error) {
      console.error('Blode web workspace unavailable', error);
    }
  }
  const noArgs = z.tuple([]);
  const routes: Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }> = {
    workspaceAsset: {
      args: z.tuple([workspaceAssetRequestSchema]),
      run: async (request) => {
        const preview = await core!.workspaceAsset(request);
        return { ...preview, url: 'blode-asset://workspace/' + preview.url.split('/').at(-1) };
      },
    },
    ...assistance.routes,
    ...hostServices.routes,
    desktopLifecycleState: { args: noArgs, run: () => desktopLifecycle!.state() },
    desktopLifecycleConfigure: {
      args: z.tuple([
        z.object({ closeToTray: z.boolean(), locale: z.enum(['zh-CN', 'en']).optional() }).strict(),
      ]),
      run: (request) => desktopLifecycle!.configure(request),
    },
    desktopCloseReply: {
      args: z.tuple([
        z
          .object({
            id: z.string().uuid(),
            decision: z.enum(['clean', 'saved', 'discard', 'cancel', 'committed', 'commitFailed']),
            error: z.string().max(512).optional(),
          })
          .strict(),
      ]),
      run: (request) => desktopLifecycle!.reply(request),
    },
    listRecentProjects: { args: noArgs, run: () => recentHistory.list() },
    openRecentProject: {
      args: z.tuple([z.string().min(1).max(4096)]),
      run: async (root) => {
        const recent = (await recentHistory.list()).find((item) => item.path === root);
        if (!recent) return { status: 'none' };
        if (!recent.available) return { status: 'missing', recent };
        await core!.setProjectRoot(recent.path);
        await recentHistory.remember(recent.path);
        return { status: 'opened', recent };
      },
    },
    removeRecentProject: {
      args: z.tuple([z.string().min(1).max(4096)]),
      run: (root) => recentHistory.remove(root),
    },
    closeProject: { args: noArgs, run: () => core!.closeProject() },
    firmwareChoose: {
      args: noArgs,
      run: async () => {
        const result = await dialog.showOpenDialog(window!, {
          title: '选择预备固件 / Choose firmware',
          properties: ['openFile'],
          filters: [
            { name: 'Firmware', extensions: ['bin', 'hex', 'ihex', 'srec', 's19', 's28', 's37', 'mot'] },
          ],
        });
        return result.canceled || !result.filePaths[0] ? null : firmwareStore.choose(result.filePaths[0]);
      },
    },
    firmwareExport: {
      args: z.tuple([z.enum(['bin', 'hex', 'srec', 'elf'])]),
      run: async (format) => {
        const state = await core!.getState();
        const prepared = await prepareBuildExport(state.projectRoot, state, format);
        const result = await dialog.showSaveDialog(window!, {
          title: '导出烧录固件 / Export firmware',
          defaultPath: prepared.defaultName,
          filters: [{ name: format.toUpperCase(), extensions: [prepared.filterExtension] }],
        });
        if (result.canceled || !result.filePath) return { status: 'cancelled' };
        await fs.writeFile(result.filePath, prepared.data);
        if (prepared.manifest) {
          const sidecar = result.filePath + '.' + Date.now() + '.json';
          await fs.writeFile(sidecar, prepared.manifest, { flag: 'wx' });
        }
        return { status: 'saved', path: result.filePath };
      },
    },
    firmwareFlash: {
      args: z.tuple([
        z
          .object({
            id: z.string().min(1).max(128),
            config: z.unknown(),
            address: z.number().int().nonnegative().max(0xffffffff).optional(),
            confirm: z.literal(true),
          })
          .strict(),
      ]),
      run: async (request) => {
        const config = parseConfig(request.config);
        await firmwareStore.withImage(request.id, config.boardId, request.address, (image) =>
          core!.flashPrepared(config, image),
        );
      },
    },
    openDebugger: { args: noArgs, run: openDebugger },
    debuggerState: {
      args: z.tuple([configSchema.optional()]),
      run: (config) => hardwareDebugger!.state(config),
    },
    debuggerSaveSettings: {
      args: z.tuple([debuggerSettingsRequestSchema]),
      run: (request) => core!.debuggerSaveSettings(request),
    },
    debuggerStorage: { args: noArgs, run: () => hardwareDebugger!.storage() },
    debuggerSymbols: {
      args: noArgs,
      run: async () => {
        const result = await dialog.showOpenDialog(debuggerWindow ?? window!, {
          title: '选择调试符号 / ELF symbols',
          properties: ['openFile'],
          filters: [{ name: 'ELF symbols', extensions: ['elf', 'axf'] }],
        });
        return result.canceled || !result.filePaths[0]
          ? null
          : hardwareDebugger!.symbolsFile(result.filePaths[0]);
      },
    },
    debuggerConnect: {
      args: z.tuple([z.unknown()]),
      run: async (config) => {
        const selection = parseConfig(config);
        await core!.runDebuggerConnect(selection, () => hardwareDebugger!.connect(selection));
      },
    },
    debuggerAction: {
      args: z.tuple([z.enum(['continue', 'pause', 'step', 'next', 'finish', 'disconnect'])]),
      run: (action) => hardwareDebugger!.action(action),
    },
    debuggerBreakpoint: {
      args: z.tuple([z.string().max(1024), z.string().regex(/^\d+$/).optional()]),
      run: (location, id) => hardwareDebugger!.breakpoint(location, id),
    },
    debuggerBreakpoints: {
      args: z.tuple([breakpointLocationsSchema]),
      run: (locations) => hardwareDebugger!.breakpoints(locations),
    },
    debuggerPatch: {
      args: z.tuple([debuggerPatchSchema]),
      run: (request) => hardwareDebugger!.patch(request),
    },
    debuggerAssemble: {
      args: z.tuple([debuggerAssembleSchema.shape.address, debuggerAssembleSchema.shape.source]),
      run: (address, source) => hardwareDebugger!.assemble(address, source),
    },
    debuggerMemory: {
      args: z.tuple([z.number().int().nonnegative().max(0xffffffff), z.number().int().min(1).max(4096)]),
      run: (address, length) => hardwareDebugger!.memory(address, length),
    },
    debuggerInstallTools: {
      args: z.tuple([configSchema.optional()]),
      run: (config) =>
        core!.runInstallation('GDB / debug server', ({ progress, log, fetcher, signal }) =>
          hardwareDebugger!.install(progress, log, { fetcher, signal, config }),
        ),
    },
    debuggerChooseGdb: {
      args: noArgs,
      run: async () => {
        const profileId = (await hardwareDebugger!.state()).profile?.id;
        const result = await dialog.showOpenDialog(debuggerWindow ?? window!, {
          title: '选择 GDB / Choose GDB',
          properties: ['openFile'],
          filters: [{ name: 'GDB', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
        });
        if (result.canceled || !result.filePaths[0]) return false;
        await hardwareDebugger!.selectGdb(result.filePaths[0], profileId);
        return true;
      },
    },
    exportProbeLog: {
      args: z.tuple([z.string().max(MAX_PROBE_LOG_BYTES)]),
      run: async (content) =>
        exportProbeLog({
          content,
          // Logs must remain exportable even if refreshing project state fails.
          projectRoot: await core!
            .getState()
            .then((state) => state.projectRoot)
            .catch(() => ''),
          dataRoot,
          choosePath: async (defaultPath) => {
            const result = await dialog.showSaveDialog(window!, {
              title: 'Export probe log / 导出探测日志',
              defaultPath,
              filters: [{ name: 'Probe log', extensions: ['log'] }],
            });
            return result.canceled ? undefined : result.filePath;
          },
        }),
    },
    getState: { args: noArgs, run: () => core!.getState() },
    listPorts: { args: noArgs, run: () => core!.listPorts() },
    listDebugProbes: { args: noArgs, run: () => core!.listDebugProbes() },
    scanDevices: { args: noArgs, run: () => core!.scanDevices() },
    saveFile: {
      args: z.tuple([
        z.string().min(1).max(1024),
        z.string().max(1_048_576),
        z.string().min(1).max(4096).optional(),
      ]),
      run: (file, content, expectedProjectRoot) => core!.saveFile(file, content, expectedProjectRoot),
    },
    createFile: {
      args: z.tuple([z.string().min(1).max(1024)]),
      run: (relative) => core!.createFile(relative),
    },
    saveConfig: {
      args: z.tuple([z.unknown(), z.string().min(1).max(4096).optional()]),
      run: (config, expectedProjectRoot) => core!.saveConfig(config, expectedProjectRoot),
    },
    setBuildEntry: {
      args: z.tuple([z.string().min(1).max(1024)]),
      run: (relative) => core!.setBuildEntry(relative),
    },
    createDirectory: {
      args: z.tuple([z.string().min(1).max(1024)]),
      run: (relative) => core!.createDirectory(relative),
    },
    renameEntry: {
      args: z.tuple([z.string().min(1).max(1024), z.string().min(1).max(1024)]),
      run: (from, to) => core!.renameEntry(from, to),
    },
    deleteEntry: {
      args: z.tuple([z.string().min(1).max(1024)]),
      run: (relative) => core!.deleteEntry(relative),
    },
    revealEntry: {
      args: z.tuple([z.string().min(1).max(1024)]),
      run: async (relative) => {
        const state = await core!.getState();
        const fullPath = await safeWorkspacePath(state.projectRoot, relative);
        await fs.stat(fullPath);
        shell.showItemInFolder(fullPath);
      },
    },
    publishDrafts: {
      args: z.tuple([z.record(z.string().max(1024), z.string().max(1_000_000))]),
      run: (drafts) => {
        web?.publishDrafts(drafts);
      },
    },
    build: {
      args: z.tuple([
        z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
          .optional(),
      ]),
      run: (targetId) => core!.build(targetId),
    },
    flash: { args: noArgs, run: () => core!.flash() },
    probe: {
      args: z.tuple([z.string().max(128).optional(), z.unknown().optional()]),
      run: (port, config) => core!.probe(port, config === undefined ? undefined : parseConfig(config)),
    },
    installToolchain: { args: noArgs, run: () => core!.installToolchain() },
    refreshDrivers: { args: noArgs, run: () => core!.driverStatuses(true) },
    installDriver: { args: z.tuple([z.literal('stlink')]), run: (id) => core!.installDriver(id) },
    serialOpen: {
      args: z.tuple([
        z.string().max(128).optional(),
        z.number().int().min(110).max(4_000_000).optional(),
        z
          .object({
            dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
            parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
            stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
            flowControl: z.enum(['none', 'rtscts', 'xonxoff']).optional(),
          })
          .strict()
          .optional(),
      ]),
      run: (port, baud, options) => core!.serialOpen(port, baud, options),
    },
    serialClose: { args: noArgs, run: () => core!.serialClose() },
    serialWrite: {
      args: z.tuple([z.string().max(65536), z.enum(['utf8', 'hex']).optional()]),
      run: (data, encoding) => core!.serialWrite(data, encoding),
    },
    selectProject: {
      args: noArgs,
      run: async () => {
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) return false;
        const root = await fs.realpath(result.filePaths[0]);
        await core!.setProjectRoot(root);
        await recentHistory.remember(root);
        return true;
      },
    },
    selectProjectMarker: {
      args: noArgs,
      run: async () => {
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openFile'],
          title: 'Blode project marker / be',
          filters: [{ name: 'All files', extensions: ['*'] }],
        });
        if (result.canceled || !result.filePaths[0]) return false;
        const marker = result.filePaths[0];
        if (path.basename(marker).toLowerCase() !== PROJECT_MARKER)
          throw new Error('error.invalidProjectMarker');
        const root = await fs.realpath(path.dirname(marker));
        await core!.setProjectRoot(root);
        await recentHistory.remember(root);
        return true;
      },
    },
    reopenProject: {
      args: noArgs,
      run: async (): Promise<ReopenProjectResult> => {
        const recent = (await recentHistory.list())[0] ?? null;
        if (!recent) return { status: 'none' };
        if (!recent.available) return { status: 'missing', recent };
        await core!.setProjectRoot(recent.path);
        await recentHistory.remember(recent.path);
        return { status: 'opened', recent };
      },
    },
    windowAction: {
      args: windowActionArgs,
      run: (action) => controlWindow(window, action),
    },
  };
  resolveRendererRoutes(routes);
  const rendererResult = await rendererLoad;
  if (!rendererResult.ok) throw rendererResult.error;
  logBoot('bootstrap services ready');
}

if (ownLock)
  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      if (closing) {
        logBoot(`bootstrap cancelled during shutdown: ${String(error)}`);
        return;
      }
      logBoot(`fatal ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      // The launcher decides whether this attempt is recoverable and reports
      // the complete startup log only if recovery ultimately fails.
      if (!devLogFile) console.error(error);
      // The development launcher reports failures and can retry a sandbox crash;
      // a modal error box would block that recovery until somebody dismisses it.
      if (!devLogFile) dialog.showErrorBox('Blode Studio', String(error));
      app.quit();
    });
app.on('window-all-closed', () => app.quit());
async function shutdownApplication() {
  if (closing) return;
  closing = true;
  logBoot('shutdown requested');
  desktopLifecycle?.dispose();
  runtimeWindows?.close();
  collaboration?.dispose();
  uiCommands?.dispose();
  const deadline = setTimeout(() => {
    logBoot('shutdown deadline reached');
    app.exit(0);
  }, 5000);
  deadline.unref();
  await hardwareDebugger?.disconnect().catch((error) => logBoot(`debugger shutdown ${String(error)}`));
  await Promise.allSettled([pipe?.close(), web?.close(), core?.shutdown(), hostServices?.close()]);
  clearTimeout(deadline);
  app.quit();
}
app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault();
  const quit = desktopLifecycle ? desktopLifecycle.requestQuit() : shutdownApplication();
  void quit.catch((error) => logBoot(`quit cancelled ${String(error)}`));
});
