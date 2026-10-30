import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCore, type CoreOptions, type CoreService } from '../src/core/service';
import { startPipeServer, type PipeServerHandle } from '../src/automation/server';
import { startWebServer, type WebServerHandle } from '../src/core/web';
import { RecentProjects } from '../src/core/recent-projects';
import { RecentLogs } from '../src/core/recent-logs';
import { FirmwareStore } from '../src/core/firmware';
import { RuntimeDebugger } from '../src/core/runtime-debugger';
import { createWebDebugger } from '../src/core/web-debugger';
import { AiAssistance } from '../src/core/ai-assistance';
import { CollaborationService } from '../src/core/collaboration';
import { createAssistanceRoutes } from '../src/core/assistance-routes';
import { UiCommands } from '../src/core/ui-commands';
import { createWorkbenchAutomation } from '../src/core/workbench-automation';
import { protectSharedWorkspace } from '../src/core/shared-workspace';
import { createHostServices } from '../src/core/host-services';
import type { LogEvent } from '../src/shared/contracts';
import { RELEASE_VERSION } from '../src/shared/version';

export interface StandaloneHostOptions {
  host?: '127.0.0.1' | '0.0.0.0';
  port?: number;
  project?: string;
  dataRoot?: string;
  appRoot?: string;
  /** Injectable platform boundary for lightweight tests; production uses registered boards. */
  createRuntimes?: CoreOptions['createRuntimes'];
  refreshDevices?: boolean;
}

export function defaultWebDataRoot(): string {
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Blode Studio Web',
    );
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Blode Studio Web');
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'blode-studio-web',
  );
}

export function parseWebArguments(args: string[]): StandaloneHostOptions & { help?: boolean } {
  const options: StandaloneHostOptions & { help?: boolean } = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (!['--host', '--port', '--project', '--data-root'].includes(flag))
      throw new Error(`Unknown option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith('--') || /[\0\r\n]/.test(value))
      throw new Error(`Missing or invalid value: ${flag}`);
    if (flag === '--host') {
      if (value !== '127.0.0.1' && value !== '0.0.0.0')
        throw new Error('--host must be 127.0.0.1 or 0.0.0.0');
      options.host = value;
    } else if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) > 65535)
        throw new Error('--port must be an integer from 0 to 65535');
      options.port = Number(value);
    } else if (flag === '--project') options.project = path.resolve(value);
    else options.dataRoot = path.resolve(value);
  }
  return options;
}

/** A target-machine workspace owner; no browser runtime or Electron APIs are required. */
export async function startStandaloneHost(options: StandaloneHostOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('Invalid host');
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new Error('Invalid port');
  const dataRoot = path.resolve(options.dataRoot ?? process.env.BLODE_DATA_ROOT ?? defaultWebDataRoot());
  const appRoot = options.appRoot ?? path.resolve(path.dirname(process.argv[1] || process.cwd()), '..');
  const toolchainRoot = path.resolve(process.env.BLODE_TOOLCHAIN_ROOT || path.join(dataRoot, 'toolchains'));
  await fs.mkdir(dataRoot, { recursive: true });
  const recent = new RecentProjects(path.join(dataRoot, 'recent-project.json'));
  const firmware = new FirmwareStore(dataRoot);
  const logs = new RecentLogs();
  let web: WebServerHandle | undefined;
  let pipe: PipeServerHandle | undefined;
  const emit = (input: LogEvent) => {
    const event = logs.publish(input);
    web?.publish(event);
    pipe?.publish(event);
  };
  let core: CoreService;
  const ui = new UiCommands((request) => web?.publishUiCommand(request));
  const hardware = new RuntimeDebugger(
    toolchainRoot,
    path.join(dataRoot, 'debugger'),
    (message) => emit({ kind: 'status', level: 'info', message, time: new Date().toISOString() }),
    () => core?.runtimePlugins,
    () => core?.currentConfig(),
  );
  core = await createCore({
    openRuntimeView: async (pluginId, view) => {
      await ui.command({ action: 'runtimeView', pluginId, viewId: view.id });
    },
    pluginRoots: [path.join(appRoot, 'extensions', 'boards'), path.join(dataRoot, 'plugins')],
    projectRoot: options.project ? path.resolve(options.project) : '',
    dataRoot,
    toolchainRoot,
    toolchainEnv: { ...process.env },
    onEvent: emit,
    hardwareBusy: () => hardware.active,
    debuggerSerialPort: () => hardware.ownedSerialPort,
    createRuntimes: options.createRuntimes,
    refreshDevices: options.refreshDevices ?? true,
  });
  const rawSaveFile = core.saveFile.bind(core);
  const collaboration = new CollaborationService({
    workspace: () => core.workspaceSnapshot(),
    freshWorkspace: () => core.workspaceSnapshot(true),
    saveFile: rawSaveFile,
    publish: (event) => web?.publishCollaboration(event),
  });
  const protection = protectSharedWorkspace(core, collaboration);
  const ai = new AiAssistance({
    dataRoot,
    projectRoot: () => core.currentProjectRoot(),
    emit,
    builtins: async () =>
      (await core.languageConfiguration())?.entries.flatMap((entry) => entry.contributions),
  });
  // Browser peers cannot claim the trusted local client's global undo permission.
  const assistance = createAssistanceRoutes(ai, collaboration, ui, false);
  const services = createHostServices({
    runtimeDebugger: () => hardware,
    core,
    collaboration,
    firmware,
    recent,
    dataRoot,
    toolchainRoot,
    emit,
    toolchainEnv: { ...process.env },
    reloadProject: protection.reload,
  });
  const originalState = core.getState.bind(core);
  core.getState = async () => {
    const [current, history, shared] = await Promise.all([
      originalState(),
      recent.list(),
      collaboration.state(),
    ]);
    return {
      ...current,
      buildStale: current.buildStale || shared.documents.some((document) => document.dirty),
      recentLogs: logs.snapshot(),
      recentProject: history[0] ?? null,
      recentProjects: history,
      pipe: { endpoint: pipe?.endpoint ?? '', tokenFile: pipe?.tokenFile ?? '' },
      web: {
        endpoint: web?.endpoint ?? '',
        tokenFile: web?.tokenFile ?? '',
        allowExternal: web?.allowExternal ?? false,
      },
    };
  };
  core.automationInvoke = createWorkbenchAutomation({
    core,
    ai,
    collaboration,
    debugger: hardware,
    firmware,
    recent,
    logs,
    ui,
    hostServices: services,
    openDebugger: async () => {
      if (!web) throw new Error('error.webUnavailable');
      const token = (await fs.readFile(web.tokenFile, 'utf8')).trim();
      return `${web.endpoint}/?token=${encodeURIComponent(token)}#/hardware-debugger`;
    },
    windowAction: () => {
      throw new Error('rpc.desktopOnly');
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    ui.dispose();
    collaboration.dispose();
    await Promise.allSettled([
      web?.close(),
      pipe?.close(),
      hardware.disconnect(),
      services.close(),
      core.shutdown(),
    ]);
  };
  try {
    await hardware.restore();
    if (options.project) await recent.remember(path.resolve(options.project));
    pipe = await startPipeServer({ api: core, dataRoot, onEvent: emit });
    web = await startWebServer({
      api: core,
      assistance,
      hostServices: services,
      debugger: createWebDebugger(hardware, core),
      packageDownload: (id) => services.packages.download(id),
      dataRoot,
      appRoot,
      isPackaged: true,
      allowExternal: host === '0.0.0.0',
      requireToken: true,
      port: options.port,
    });
    return { core, web, pipe, dataRoot, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const help = `Blode Studio Web host ${RELEASE_VERSION} (Node.js 24+, no Electron)
Usage: node dist/web-server.cjs [options]
  --host 127.0.0.1|0.0.0.0  Bind address (default: 127.0.0.1)
  --port <0-65535>            HTTP port (default: 47821; 0 selects a free port)
  --project <directory>       Open a directory on this host at startup
  --data-root <directory>     Host settings, credentials, history and downloaded tools
  --help                     Show this help
`;

async function main() {
  const options = parseWebArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  const host = await startStandaloneHost(options);
  // Deliberate one-time launch link; ordinary logs and state never contain its token value.
  const token = (await fs.readFile(host.web.tokenFile, 'utf8')).trim();
  process.stdout.write(
    `Blode Studio Web ${RELEASE_VERSION} is ready. Open this private link:\n${host.web.endpoint}/?token=${encodeURIComponent(token)}\n`,
  );
  process.stdout.write(`Host data: ${host.dataRoot}\nPress Ctrl+C to stop.\n`);
  const stop = () =>
    void host.close().then(() => {
      process.exitCode = 0;
    });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (/^web-server\.(?:ts|js|cjs|mjs)$/i.test(path.basename(process.argv[1] ?? '')))
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
