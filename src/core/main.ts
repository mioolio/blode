import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, session, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createCore, type CoreService } from './service';
import { listBoards } from '../../extensions/registry';
import { startPipeServer, type PipeServerHandle } from '../automation/server';
import { EVENT_CHANNEL, IPC_CHANNEL, type LogEvent } from '../shared/contracts';
import { loadAppConfig, installDebugControls } from './debug';
import { PROJECT_MARKER, safeWorkspacePath } from './workspace';
import { startWebServer, type WebServerHandle } from './web';

app.setName('Blode Studio');
// Follow the operating system theme; the renderer reads the same preference via CSS.
nativeTheme.themeSource = 'system';
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#0b0e14' : '#eef1f6');
let window: BrowserWindow | null = null;
let core: CoreService | null = null;
let pipe: PipeServerHandle | null = null;
let web: WebServerHandle | null = null;
let closing = false;
const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const ownLock = app.requestSingleInstanceLock();
if (!ownLock) app.quit();
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
  const applicationConfig = await loadAppConfig(path.join(app.getAppPath(), 'config', 'application.json'));
  // Board adapters are code, but every chip model must declare itself in this folder.
  await verifyBoardFolder(
    app.isPackaged
      ? path.join(process.resourcesPath, 'boards')
      : path.join(app.getAppPath(), 'extensions', 'boards'),
  );
  const dataRoot = process.env.BLODE_DATA_ROOT || app.getPath('userData');
  // No workspace is opened on startup; the welcome screen asks for a project area.
  const projectRoot = process.env.BLODE_PROJECT_ROOT || '';
  const emit = (event: LogEvent) => {
    if (window && !window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, event);
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
  core = await createCore({
    projectRoot,
    dataRoot,
    onEvent: emit,
    toolchainEnv,
    fetcher: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    // A repository-local tools folder keeps local builds independent of AppData.
    toolchainRoot:
      process.env.BLODE_TOOLCHAIN_ROOT || (app.isPackaged ? undefined : path.join(app.getAppPath(), 'tools')),
  });
  // The UI and all automation routes use the same service instance and locks.
  const state = core.getState.bind(core);
  core.getState = async () => ({
    ...(await state()),
    pipe: { endpoint: pipe?.endpoint ?? '', tokenFile: pipe?.tokenFile ?? '' },
    web: {
      endpoint: web?.endpoint ?? '',
      tokenFile: web?.tokenFile ?? '',
      allowExternal: web?.allowExternal ?? false,
    },
  });
  pipe = await startPipeServer({ api: core, dataRoot, onEvent: emit });
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
    getState: { args: noArgs, run: () => core!.getState() },
    listPorts: { args: noArgs, run: () => core!.listPorts() },
    saveFile: {
      args: z.tuple([z.string().min(1).max(1024), z.string().max(1_048_576)]),
      run: (file, content) => core!.saveFile(file, content),
    },
    createFile: {
      args: z.tuple([z.string().min(1).max(1024)]),
      run: (relative) => core!.createFile(relative),
    },
    saveConfig: { args: z.tuple([z.unknown()]), run: (config) => core!.saveConfig(config) },
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
    probe: { args: z.tuple([z.string().max(128).optional()]), run: (port) => core!.probe(port) },
    installToolchain: { args: noArgs, run: () => core!.installToolchain() },
    serialOpen: {
      args: z.tuple([z.string().max(128).optional(), z.number().int().min(1200).max(3_000_000).optional()]),
      run: (port, baud) => core!.serialOpen(port, baud),
    },
    serialClose: { args: noArgs, run: () => core!.serialClose() },
    serialWrite: { args: z.tuple([z.string().max(8192)]), run: (data) => core!.serialWrite(data) },
    selectProject: {
      args: noArgs,
      run: async () => {
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) return false;
        await core!.setProjectRoot(result.filePaths[0]);
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
        await core!.setProjectRoot(path.dirname(marker));
        return true;
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
    if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame)
      throw new Error('error.unauthorized');
    if (typeof method !== 'string' || !Object.hasOwn(routes, method)) throw new Error('error.unknownMethod');
    const route = routes[method];
    const parsed = route.args.safeParse(args);
    if (!parsed.success) throw new Error('error.invalidArguments');
    return route.run(...(parsed.data as unknown[]));
  });
  window.once('ready-to-show', () => window?.show());
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
      console.error(error);
      dialog.showErrorBox('Blode Studio', String(error));
      app.quit();
    });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  void Promise.allSettled([pipe?.close(), web?.close(), core?.shutdown()]).then(() => app.quit());
});
