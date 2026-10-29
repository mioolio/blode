import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, session, shell } from 'electron';
import { appendFileSync, mkdirSync, promises as fs, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createCore, type CoreService } from './service';
import { listBoards } from '../../extensions/registry';
import { startPipeServer, type PipeServerHandle } from '../automation/server';
import {
  EVENT_CHANNEL,
  IPC_CHANNEL,
  type LogEvent,
  type RecentProject,
  type ReopenProjectResult,
} from '../shared/contracts';
import { loadAppConfig, installDebugControls } from './debug';
import { parseConfig } from './config';
import { PROJECT_MARKER, safeWorkspacePath } from './workspace';
import { startWebServer, type WebServerHandle } from './web';
import { exportProbeLog } from './log-export';
import { MAX_PROBE_LOG_BYTES } from '../shared/probe-log';
import { RecentProjects } from './recent-projects';
import { FirmwareStore, prepareBuildExport } from './firmware';
import { HardwareDebugger } from './hardware-debugger';

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
function logBoot(message: string): void {
  if (!devLogFile) return;
  try {
    appendFileSync(devLogFile, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* A broken diagnostic log must never block startup. */
  }
}
logBoot(`start pid=${process.pid} packaged=${app.isPackaged} electron=${process.versions.electron}`);
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
let window: BrowserWindow | null = null;
let core: CoreService | null = null;
let pipe: PipeServerHandle | null = null;
let web: WebServerHandle | null = null;
let closing = false;
let debuggerWindow: BrowserWindow | null = null;
let hardwareDebugger: HardwareDebugger | null = null;
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
  const dataRoot = process.env.BLODE_DATA_ROOT || app.getPath('userData');
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
  const emit = (event: LogEvent) => {
    if (window && !window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event);
    if (debuggerWindow && !debuggerWindow.isDestroyed())
      debuggerWindow.webContents.send(EVENT_CHANNEL, event);
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
    projectRoot,
    dataRoot,
    onEvent: emit,
    refreshDevices: true,
    hardwareBusy: () => !!hardwareDebugger?.active,
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
  // The UI and all automation routes use the same service instance and locks.
  const state = core.getState.bind(core);
  core.getState = async () => ({
    ...(await state()),
    recentProject: (await recentHistory.list())[0] ?? null,
    recentProjects: await recentHistory.list(),
    pipe: { endpoint: pipe?.endpoint ?? '', tokenFile: pipe?.tokenFile ?? '' },
    web: {
      endpoint: web?.endpoint ?? '',
      tokenFile: web?.tokenFile ?? '',
      allowExternal: web?.allowExternal ?? false,
    },
  });
  hardwareDebugger = new HardwareDebugger(
    process.env.BLODE_TOOLCHAIN_ROOT ||
      (bundledToolsReady ? bundledTools : path.join(dataRoot, 'toolchains')),
    path.join(dataRoot, 'debugger'),
    (message) => emit({ kind: 'status', level: 'info', message, time: new Date().toISOString() }),
  );
  await hardwareDebugger.restore();
  if (projectRoot) await recentHistory.remember(projectRoot).catch(() => {});
  const openDebugger = async () => {
    if (debuggerWindow && !debuggerWindow.isDestroyed()) {
      debuggerWindow.show();
      debuggerWindow.focus();
      return;
    }
    debuggerWindow = new BrowserWindow({
      title: 'Blode Studio · 硬件仿真',
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
    secondary.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    secondary.webContents.on('will-navigate', (e) => e.preventDefault());
    secondary.once('ready-to-show', () => secondary.show());
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
  pipe = await startPipeServer({ api: core, dataRoot, onEvent: emit });
  logBoot(`pipe ready ${pipe.endpoint}`);
  if (applicationConfig.web.enabled) {
    try {
      web = await startWebServer({
        api: core,
        dataRoot,
        appRoot: app.getAppPath(),
        isPackaged: app.isPackaged,
        rendererUrl: developmentUrl,
        allowExternal: applicationConfig.web.allowExternal,
      });
    } catch (error) {
      console.error('Blode web workspace unavailable', error);
    }
  }
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
  if (process.platform === 'win32') {
    // Windows broadcasts topology changes to top-level windows. No polling of USB/SWD is needed.
    window.hookWindowMessage(0x0219, (wParam) => {
      if (closing || wParam.length < 4) return;
      const change = wParam.readUInt32LE(0);
      if (change === 0x0007 || change === 0x8000 || change === 0x8004) core?.notifyDevicesChanged();
    });
  }
  let interfaceCheck: ReturnType<typeof setInterval> | undefined;
  window.webContents.on('did-finish-load', () => {
    clearInterval(interfaceCheck);
    let pending = false;
    interfaceCheck = setInterval(async () => {
      if (pending || !window || window.isDestroyed()) return;
      pending = true;
      try {
        const mounted = await window.webContents.executeJavaScript(
          `!!document.querySelector('#root > .studio .ide-menubar') || (!!document.querySelector('#root > .studio') && document.querySelector('#root').innerText.length > 20)`,
        );
        if (!mounted) return;
        clearInterval(interfaceCheck);
        windowShown = true;
        window.show();
        logBoot('window ready interface=mounted');
        if (devLogFile && process.env.BLODE_RENDER_DIAGNOSTICS === '1') {
          const capture = await window.webContents.capturePage();
          await fs.writeFile(path.join(path.dirname(devLogFile), 'dev-renderer.png'), capture.toPNG());
        }
      } catch (error) {
        logBoot(`renderer-interface-error ${String(error)}`);
      } finally {
        pending = false;
      }
    }, 250);
  });
  window.once('closed', () => clearInterval(interfaceCheck));
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
    logBoot(`render-process-gone ${details.reason} exit=${details.exitCode}`);
    if (closing || !windowShown || window?.isDestroyed()) return;
    if (!rendererRecoveryUsed && details.reason !== 'clean-exit') {
      rendererRecoveryUsed = true;
      logBoot('recovering crashed renderer');
      window?.webContents.reloadIgnoringCache();
    } else app.quit();
  });
  const disposeDebugControls = installDebugControls(window, {
    ...applicationConfig.debug,
    enabled: !app.isPackaged && applicationConfig.debug.enabled,
  });
  window.on('closed', disposeDebugControls);
  const syncWindowBackground = () => window?.setBackgroundColor(windowBackground());
  nativeTheme.on('updated', syncWindowBackground);
  window.on('closed', () => nativeTheme.off('updated', syncWindowBackground));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );

  const noArgs = z.tuple([]);
  const routes: Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }> = {
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
    debuggerState: { args: noArgs, run: () => hardwareDebugger!.state() },
    debuggerStorage: { args: noArgs, run: () => hardwareDebugger!.storage() },
    debuggerSymbols: {
      args: noArgs,
      run: async () => {
        const result = await dialog.showOpenDialog(debuggerWindow ?? window!, {
          title: '选择调试符号 / ELF symbols',
          properties: ['openFile'],
          filters: [{ name: 'ARM ELF', extensions: ['elf', 'axf'] }],
        });
        return result.canceled || !result.filePaths[0]
          ? null
          : hardwareDebugger!.symbolsFile(result.filePaths[0]);
      },
    },
    debuggerConnect: {
      args: z.tuple([z.unknown()]),
      run: async (config) => {
        await core!.runHardwareAction(() => hardwareDebugger!.connect(parseConfig(config)));
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
    debuggerMemory: {
      args: z.tuple([z.number().int().nonnegative().max(0xffffffff), z.number().int().min(1).max(4096)]),
      run: (address, length) => hardwareDebugger!.memory(address, length),
    },
    debuggerInstallTools: {
      args: noArgs,
      run: () =>
        core!.runInstallation('GNU Arm GCC / GDB', ({ progress, log, fetcher, signal }) =>
          hardwareDebugger!.install(progress, log, { fetcher, signal }),
        ),
    },
    debuggerChooseGdb: {
      args: noArgs,
      run: async () => {
        const result = await dialog.showOpenDialog(debuggerWindow ?? window!, {
          title: '选择 arm-none-eabi-gdb',
          properties: ['openFile'],
          filters: [{ name: 'GDB', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
        });
        if (result.canceled || !result.filePaths[0]) return false;
        await hardwareDebugger!.selectGdb(result.filePaths[0]);
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
      args: z.tuple([z.string().min(1).max(1024), z.string().max(1_048_576)]),
      run: (file, content) => core!.saveFile(file, content),
    },
    createFile: {
      args: z.tuple([z.string().min(1).max(1024)]),
      run: (relative) => core!.createFile(relative),
    },
    saveConfig: { args: z.tuple([z.unknown()]), run: (config) => core!.saveConfig(config) },
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
    build: { args: noArgs, run: () => core!.build() },
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
      args: z.tuple([z.enum(['minimize', 'maximize', 'close'])]),
      run: (action) => {
        if (action === 'minimize') window?.minimize();
        if (action === 'maximize') {
          if (window?.isMaximized()) window.unmaximize();
          else window?.maximize();
        }
        if (action === 'close') window?.close();
      },
    },
  };
  ipcMain.handle(IPC_CHANNEL, (event, method: unknown, args: unknown) => {
    const secondary = event.sender === debuggerWindow?.webContents;
    if ((event.sender !== window?.webContents && !secondary) || event.senderFrame !== event.sender.mainFrame)
      throw new Error('error.unauthorized');
    if (
      secondary &&
      method !== 'getState' &&
      method !== 'listDebugProbes' &&
      method !== 'windowAction' &&
      !(typeof method === 'string' && method.startsWith('debugger'))
    )
      throw new Error('error.unauthorized');
    if (typeof method !== 'string' || !Object.hasOwn(routes, method)) throw new Error('error.unknownMethod');
    const route = routes[method];
    const parsed = route.args.safeParse(args);
    if (!parsed.success) throw new Error('error.invalidArguments');
    if (secondary && method === 'windowAction') {
      const target = debuggerWindow;
      const [action] = parsed.data as ['minimize' | 'maximize' | 'close'];
      if (action === 'minimize') target?.minimize();
      if (action === 'maximize' && target) {
        if (target.isMaximized()) target.unmaximize();
        else target.maximize();
      }
      if (action === 'close') target?.close();
      return;
    }
    return route.run(...(parsed.data as unknown[]));
  });
  window.once('ready-to-show', () => {
    window?.show();
  });
  window.once('closed', () => debuggerWindow?.close());
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (url.origin !== 'http://127.0.0.1:5173') throw new Error('error.invalidDevServer');
    await window.loadURL(url.toString());
  } else await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (ownLock)
  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
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
app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  const deadline = setTimeout(() => {
    logBoot('shutdown deadline reached');
    app.exit(0);
  }, 5000);
  deadline.unref();
  void Promise.allSettled([
    pipe?.close(),
    web?.close(),
    core?.shutdown(),
    hardwareDebugger?.disconnect(),
  ]).then(() => {
    clearTimeout(deadline);
    app.quit();
  });
});
