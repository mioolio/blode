import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { ModelService } from './model-service';
import { createModelRoutes } from './model-service/routes';
import type { AiAssistance } from './ai-assistance';
import type { LogEvent } from '../shared/contracts';
import type { CoreService } from './service';
import type { CollaborationService } from './collaboration';
import type { RecentProjects } from './recent-projects';
import { FirmwareStore, prepareBuildExport } from './firmware';
import { GitService, createGitRoutes } from './git';
import { ToolVersions } from './tool-versions';
import { ProjectPackages } from './project-package';
import { DevicePackages } from './device-packages';
import { BundledArchiveWriter } from './archive-writer';
import { openHostDirectory, type OpenDirectoryOptions } from './open-directory';
import { OfflineTools } from './tool-offline';
import { inspectSmallPackage } from './package-inspection';
import { packageInspectSchema } from './package-signing-schemas';
import { HostTerminals } from './terminal-sessions';
import { ComponentLibraries } from './components';
import { createDeliveryRoutes } from './delivery-routes';
import type { ComponentLibrariesState } from '../shared/components';
import { browseHost } from './host-files';
import { openVSCode, type VSCodeOptions } from './vscode';
import { runCommand } from './process';
import { configSchema, parseProjectBuild } from './config';
import { toolVersionSchemas } from './tool-version-schemas';
import { hostParameterSchemas } from './host-service-schemas';
import { LanguageIndexService } from './language-index';
import { GeneralExtensions } from './general-extensions';
import { createGeneralExtensionRoutes } from './general-extensions/routes';
import { LanguageNavigationService } from './language-navigation';
import { WorkspaceLanguageServer } from './language-server';
import { lspNotifySchema, lspRequestSchema } from './lsp-schemas';
import { ClangdService } from './clangd/manager';
import { clangdDiagnosticsSchema, clangdNotifySchema, clangdRequestSchema } from './clangd/schemas';
import { ExplorerStateStore } from './explorer-state';
import { explorerStateSaveSchema } from './explorer-schemas';
import { languageNavigationSchema, languageExternalSchema, languageCancelSchema } from './language-schemas';
import type { RuntimeDebugger } from './runtime-debugger';
import { isRuntimeViewKind, type RuntimeViewContribution, type RuntimeViewKind } from '../shared/plugins';

interface Options {
  directoryOpener?: OpenDirectoryOptions;
  builtinDevicePackagesRoot?: string;
  builtinArchiveRoot?: string;
  extensionExamplesRoot?: string;
  openExtensionView?: (id: string, view: RuntimeViewContribution) => Promise<void>;
  openExtensionPanel?: (id: string, view: RuntimeViewContribution) => Promise<void>;
  extensionViewUrl?: (id: string, view: string) => string;
  ai?: AiAssistance;
  core: CoreService;
  collaboration: CollaborationService;
  firmware: FirmwareStore;
  recent: RecentProjects;
  dataRoot: string;
  toolchainRoot: string;
  emit: (event: LogEvent) => void;
  fetcher?: typeof fetch;
  toolchainEnv?: NodeJS.ProcessEnv;
  vscode?: Pick<VSCodeOptions, 'findExecutable' | 'launch'>;
  reloadProject?: () => Promise<void>;
  savePackage?: (file: { path: string; name: string }) => Promise<boolean>;
  runtimeDebugger?: () => RuntimeDebugger | undefined;
  runtimeViewDocument?: (id: string, kind: RuntimeViewKind) => string;
  openRuntimeView?: (
    id: string,
    view: RuntimeViewContribution,
  ) => Promise<{ destination: 'window' | 'browser'; url?: string }>;
}
const absolute = (value: string) => {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('error.invalidPath');
  return path.resolve(value);
};
/** One validated capability registry shared by IPC, HTTP and trusted local AI. */
export function createHostServices(options: Options) {
  const { core, collaboration } = options;
  const generalExtensions = new GeneralExtensions({
    enforceSignatures: true,
    dataRoot: options.dataRoot,
    examplesRoot: options.extensionExamplesRoot,
    openView: options.openExtensionView,
    openPanel: options.openExtensionPanel,
    changed: () =>
      options.emit({
        kind: 'status',
        level: 'info',
        message: 'status.extensionsChanged',
        time: new Date().toISOString(),
      }),
    log: (message) => options.emit({ kind: 'log', level: 'info', message, time: new Date().toISOString() }),
  });
  const extensionRoutes = createGeneralExtensionRoutes(
    generalExtensions,
    options.savePackage,
    options.extensionViewUrl,
  );
  const model = new ModelService({
    dataRoot: options.dataRoot,
    projectRoot: () => core.currentProjectRoot(),
    collaboration,
    emit: options.emit,
    fetcher: options.fetcher,
    automate: (method, params) => {
      if (!core.automationInvoke) throw new Error('rpc.methodNotFound');
      return core.automationInvoke(method, params);
    },
    refreshFiles: () => core.workspaceSnapshot(true),
  });
  const modelRoutes = createModelRoutes(model);
  options.ai?.setPredictionEngine({
    handles: () => model.handlesPredictions(),
    complete: (request, signal) => model.predict(request, signal),
  });
  const language = new LanguageIndexService(core);
  const languageNavigation = new LanguageNavigationService({
    core,
    toolchainRoot: options.toolchainRoot,
    env: options.toolchainEnv,
  });
  const languageServer = new WorkspaceLanguageServer({ core, navigation: languageNavigation });
  const clangd = new ClangdService({
    core,
    dataRoot: options.dataRoot,
    toolchainRoot: options.toolchainRoot,
    env: options.toolchainEnv,
  });
  const explorer = new ExplorerStateStore(core);
  collaboration.setReadonlySources?.((root) => languageNavigation.readonlyPaths(root));
  const git = new GitService({ projectRoot: () => core.currentProjectRoot(), emit: options.emit });
  const terminal = new HostTerminals({ projectRoot: () => core.currentProjectRoot(), emit: options.emit });
  const projectBuild = async () => {
    const marker = (await core.workspaceSnapshot()).files.find((file) => file.path === 'be');
    if (!marker?.content.trim()) return {};
    try {
      return parseProjectBuild(JSON.parse(marker.content).build);
    } catch {
      return {};
    }
  };
  const components = new ComponentLibraries({
    enforceSignatures: true,
    projectRoot: () => core.currentProjectRoot(),
    config: () => core.currentConfig(),
    build: projectBuild,
    dataRoot: options.dataRoot,
    toolchainRoot: options.toolchainRoot,
    fetcher: options.fetcher,
    env: options.toolchainEnv,
  });
  const componentAction = async (
    action: (
      hooks: Parameters<Parameters<CoreService['runInstallation']>[1]>[0],
    ) => Promise<ComponentLibrariesState>,
  ) =>
    collaboration.workspaceAction(async () => {
      let result!: ComponentLibrariesState;
      await core.runInstallation('components', async (hooks) => {
        result = await action(hooks);
      });
      await core.workspaceSnapshot(true);
      options.emit({
        kind: 'status',
        level: 'success',
        message: 'status.workspaceChanged',
        time: new Date().toISOString(),
      });
      return result;
    });
  const packages = new ProjectPackages({
    dataRoot: options.dataRoot,
    projectRoot: () => core.currentProjectRoot(),
    toolchainRoots: () => [
      options.toolchainRoot,
      ...Object.values(core.currentConfig().toolchain).filter(
        (value): value is string => typeof value === 'string' && path.isAbsolute(value),
      ),
    ],
    buildEvidenceState: () => core.buildEvidenceState(),
    privateRoots: () => [options.dataRoot],
  });
  const toolRunner: typeof runCommand = (command, args, settings = {}) =>
    runCommand(command, args, { ...settings, env: { ...options.toolchainEnv, ...settings.env } });
  const toolOptions = {
    enforceSignatures: true,
    root: options.toolchainRoot,
    dataRoot: options.dataRoot,
    config: () => core.currentConfig(),
    build: projectBuild,
    runner: toolRunner,
    env: options.toolchainEnv,
    fetcher: options.fetcher,
    archiver: new BundledArchiveWriter({
      root: options.builtinArchiveRoot ?? path.resolve('dist/archive-tools'),
      dataRoot: options.dataRoot,
      runner: toolRunner,
    }),
  };
  const tools = new ToolVersions(toolOptions);
  const devicePackages = new DevicePackages({
    enforceSignatures: true,
    dataRoot: options.dataRoot,
    builtinRoot: options.builtinDevicePackagesRoot ?? path.resolve('dist/device-modules'),
    plugins: () => Promise.resolve(core.runtimePlugins.packageInventory?.() ?? core.runtimePlugins.state()),
    reload: () => core.refreshDeviceModules(),
  });
  const delivery = createDeliveryRoutes({
    dataRoot: options.dataRoot,
    projectRoot: () => core.currentProjectRoot(),
    savePackage: options.savePackage,
    toolOptions,
    runInstallation: core.runInstallation,
  });
  const noArgs = z.tuple([]),
    nativePath = z.string().min(1).max(4096);
  const routes: Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }> = {
    ...extensionRoutes.routes,
    ...modelRoutes.routes,
    ...delivery.routes,
    packageInspect: {
      args: z.tuple([packageInspectSchema]),
      run: (request) =>
        request.kind === 'tool'
          ? new OfflineTools(toolOptions).inspect(request.path)
          : inspectSmallPackage(request.path, request.kind),
    },
    devicePackageOpenLocation: {
      args: z.tuple([z.string().min(1).max(80)]),
      run: async (id) => {
        const entry = (await devicePackages.state()).packages.find((entry) => entry.id === id);
        if (!entry) throw new Error('error.devicePackageUnknown');
        await openHostDirectory(entry.directory, options.directoryOpener);
      },
    },
    devicePackagesState: { args: noArgs, run: () => devicePackages.state() },
    devicePackagesVerify: {
      args: z.tuple([z.array(z.string().min(1).max(80)).max(25)]),
      run: (ids) => devicePackages.verify(ids),
    },
    devicePackageReview: {
      args: z.tuple([hostParameterSchemas['devices.review']]),
      run: (request) => devicePackages.review(request),
    },
    devicePackageInstall: {
      args: z.tuple([hostParameterSchemas['devices.install']]),
      run: async (request) => {
        let result;
        await core.runHardwareAction(async () => {
          result = await devicePackages.install(request);
        });
        return result;
      },
    },
    devicePackageExport: {
      args: z.tuple([hostParameterSchemas['devices.export']]),
      run: (request) => devicePackages.export(request),
    },
    devicePackageSave: {
      args: z.tuple([z.string().uuid()]),
      run: (id) => {
        if (!options.savePackage) throw new Error('rpc.desktopOnly');
        return options.savePackage(devicePackages.download(id));
      },
    },
    componentsState: { args: noArgs, run: () => components.list() },
    componentsSearch: {
      args: z.tuple([hostParameterSchemas['components.search'].shape.query]),
      run: (query) => components.search(query),
    },
    componentsInstall: {
      args: z.tuple([hostParameterSchemas['components.install']]),
      run: (request) => componentAction((hooks) => components.install(request, hooks)),
    },
    componentsImport: {
      args: z.tuple([hostParameterSchemas['components.import']]),
      run: (request) =>
        componentAction((hooks) =>
          request.kind === 'archive'
            ? components.importArchive(request.path, request.expectedProjectRoot, hooks, request.approval)
            : components.importDirectory(request.path, request.expectedProjectRoot, hooks, request.approval),
        ),
    },
    componentsRemove: {
      args: z.tuple([hostParameterSchemas['components.remove']]),
      run: (request) => componentAction(() => components.remove(request)),
    },
    runtimePluginViewInfo: {
      args: z.tuple([z.string().min(1).max(80), z.string().min(1).max(80)]),
      run: async (id, viewId) => {
        await core.runtimePlugins.view(id, `view:${viewId}`);
        const view = (await core.runtimePlugins.state()).plugins
          .find((plugin) => plugin.id === id)
          ?.manifest.ui.views?.find((view) => view.id === viewId);
        if (!view) throw new Error('error.runtimePluginCapability');
        return view;
      },
    },
    runtimePluginOpenView: {
      args: z.tuple([z.string().min(1).max(80), z.string().min(1).max(80)]),
      run: async (id, viewId) => {
        const view = (await routes.runtimePluginViewInfo.run(id, viewId)) as RuntimeViewContribution;
        if (view.location === 'panel') return { destination: 'panel' };
        return options.openRuntimeView?.(id, view) ?? { destination: 'browser' };
      },
    },
    runtimePluginsState: { args: noArgs, run: () => core.runtimePlugins.state() },
    runtimePluginTrust: {
      args: z.tuple([
        z
          .object({
            id: z.string().min(1).max(80),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            confirm: z.literal(true),
            permanent: z.boolean(),
          })
          .strict(),
      ]),
      run: async (request) => {
        let result;
        await core.runHardwareAction(async () => {
          result = await core.runtimePlugins.trust(request);
        });
        options.emit({
          kind: 'status',
          level: 'info',
          message: 'status.runtimePluginTrusted',
          time: new Date().toISOString(),
        });
        core.notifyDevicesChanged();
        return result;
      },
    },
    runtimePluginView: {
      args: z.tuple([z.string().min(1).max(80), z.custom<RuntimeViewKind>(isRuntimeViewKind)]),
      run: (id, kind) => core.runtimePlugins.view(id, kind),
    },
    runtimePluginViewDocument: {
      args: z.tuple([z.string().min(1).max(80), z.custom<RuntimeViewKind>(isRuntimeViewKind)]),
      run: async (id, kind) => {
        const html = await core.runtimePlugins.view(id, kind);
        return html ? (options.runtimeViewDocument?.(id, kind) ?? null) : null;
      },
    },
    runtimePluginDebug: {
      args: z.tuple([z.string().min(1).max(80), z.string().min(1).max(80), z.array(z.unknown()).max(8)]),
      run: async (id, method, args) => {
        const debug = options.runtimeDebugger?.();
        if (!debug) throw new Error('error.runtimeDebuggerUnsupported');
        if (['state', 'storage'].includes(method)) return debug.invokePlugin(id, method, args);
        // Cancellation must reach the debugger while connect holds the core operation lock.
        if (method === 'disconnect' || (method === 'action' && args[0] === 'disconnect'))
          return debug.invokePlugin(id, method, args);
        if (method === 'connect') {
          const config = core.currentConfig();
          if (config.boardId !== id) throw new Error('error.runtimePluginConfig');
          let result;
          await core.runDebuggerConnect(config, async () => {
            result = await debug.invokePlugin(id, method, args);
          });
          return result;
        }
        let result;
        await core.runDebuggerAction(async () => {
          result = await debug.invokePlugin(id, method, args);
        });
        return result;
      },
    },
    runtimePluginContext: {
      args: z.tuple([z.string().min(1).max(80)]),
      run: async (id) => {
        const plugin = (await core.runtimePlugins.state()).plugins.find((item) => item.id === id);
        if (!plugin) throw new Error('error.runtimePluginMissing');
        const config = core.currentConfig();
        const defaults = Object.fromEntries(
          plugin.manifest.ui.fields
            .filter((field) => field.default !== undefined)
            .map((field) => [field.id, field.default]),
        );
        return {
          deviceId: config.boardId === id ? (config.runtime?.deviceId ?? '') : '',
          values: { ...defaults, ...(config.boardId === id ? config.runtime?.values : {}) },
          capabilities: plugin.manifest.capabilities,
          support: plugin.manifest.support,
          layout: plugin.manifest.layout,
        };
      },
    },
    runtimePluginConfigure: {
      args: z.tuple([
        z.string().min(1).max(80),
        configSchema.shape.runtime
          .unwrap()
          .pick({ deviceId: true, values: true, disabledCapabilities: true }),
      ]),
      run: async (id, value) => {
        const config = core.currentConfig();
        if (config.boardId !== id) throw new Error('error.runtimePluginConfig');
        await core.saveConfig({
          ...config,
          runtime: {
            ...config.runtime,
            ...value,
            ...(value.values ? { values: { ...config.runtime?.values, ...value.values } } : {}),
          },
        });
      },
    },
    runtimePluginDevice: {
      args: z.tuple([
        z.string().min(1).max(80),
        z.string().min(1).max(80),
        z.array(z.unknown()).max(8),
        z.literal(true).optional(),
      ]),
      run: async (id, method, args, confirm) => {
        if (core.currentConfig().boardId !== id) throw new Error('error.runtimePluginConfig');
        let result;
        await core.runHardwareAction(async () => {
          result = await core.runtimePlugins.invokeDevice(id, method, args, confirm);
        });
        return result;
      },
    },
    languageIndex: { args: noArgs, run: () => language.snapshot() },
    languageLspRequest: {
      args: z.tuple([lspRequestSchema]),
      run: (request) => languageServer.request(request),
    },
    languageLspNotify: {
      args: z.tuple([lspNotifySchema]),
      run: (request) => languageServer.notify(request),
    },
    languageClangdState: { args: noArgs, run: () => clangd.state() },
    languageClangdRequest: {
      args: z.tuple([clangdRequestSchema]),
      run: (request) => clangd.request(request),
    },
    languageClangdNotify: {
      args: z.tuple([clangdNotifySchema]),
      run: (request) => clangd.notify(request),
    },
    languageClangdDiagnostics: {
      args: z.tuple([clangdDiagnosticsSchema]),
      run: (request) => clangd.diagnostics(request),
    },
    languageNavigate: {
      args: z.tuple([languageNavigationSchema]),
      run: (request) => languageNavigation.navigate(request),
    },
    languageCancel: {
      args: z.tuple([languageCancelSchema]),
      run: (request) => languageNavigation.cancel(request),
    },
    languageOpenExternal: {
      args: z.tuple([languageExternalSchema]),
      run: (request) => languageNavigation.openExternal(request),
    },
    explorerState: { args: noArgs, run: () => explorer.state() },
    explorerStateSave: {
      args: z.tuple([explorerStateSaveSchema]),
      run: (request) => explorer.save(request.expectedProjectRoot, request.state),
    },
    ...createGitRoutes(git).routes,
    toolVersionsState: { args: noArgs, run: () => tools.toolVersionsState() },
    toolVersionSelect: {
      args: z.tuple([toolVersionSchemas.select]),
      run: (request) => tools.toolVersionSelect(request),
    },
    toolVersionInstall: {
      args: z.tuple([toolVersionSchemas.install]),
      run: async (request) => {
        await core.runInstallation(request.id, async (reporter) => {
          await new ToolVersions({
            ...toolOptions,
            fetcher: reporter.fetcher ?? options.fetcher,
            signal: reporter.signal,
            onLine: reporter.log,
            onProgress: reporter.progress,
          }).toolVersionInstall(request);
        });
        clangd.invalidate();
        return tools.toolVersionsState();
      },
    },
    hostBrowse: { args: z.tuple([nativePath.optional()]), run: (directory) => browseHost(directory) },
    vscodeOpen: {
      args: z.tuple([hostParameterSchemas['vscode.open']]),
      run: (request) =>
        openVSCode(
          {
            projectRoot: () => core.currentProjectRoot(),
            config: () => core.currentConfig(),
            ...options.vscode,
          },
          request,
        ),
    },
    hostOpenProject: {
      args: z.tuple([nativePath]),
      run: async (root) => {
        const resolved = absolute(root);
        await core.setProjectRoot(resolved);
        await options.recent.remember(resolved);
        return true;
      },
    },
    listRecentProjects: { args: noArgs, run: () => options.recent.list() },
    removeRecentProject: {
      args: z.tuple([nativePath]),
      run: (root) => options.recent.remove(absolute(root)),
    },
    openRecentProject: {
      args: z.tuple([nativePath]),
      run: async (root) => {
        const recent = (await options.recent.list()).find((item) => item.path === root);
        if (!recent) return { status: 'none' };
        if (!recent.available) return { status: 'missing', recent };
        await core.setProjectRoot(recent.path);
        await options.recent.remember(recent.path);
        return { status: 'opened', recent };
      },
    },
    closeProject: { args: noArgs, run: () => core.closeProject() },
    projectPackagePreview: { args: noArgs, run: () => packages.preview() },
    projectPackageExport: {
      args: z.tuple([hostParameterSchemas['project.package.export']]),
      run: (request) => collaboration.workspaceAction(() => packages.export(request)),
    },
    projectPackageSave: {
      args: z.tuple([z.string().uuid()]),
      run: (id) => {
        if (!options.savePackage) throw new Error('rpc.desktopOnly');
        return options.savePackage(packages.download(id));
      },
    },
    terminalSessions: { args: noArgs, run: () => terminal.sessions() },
    terminalState: {
      args: z.tuple([hostParameterSchemas['terminal.state'].optional()]),
      run: (cursor) => terminal.state(cursor),
    },
    terminalOpen: {
      args: z.tuple([hostParameterSchemas['terminal.open'].omit({ confirm: true }).optional()]),
      run: (size) => terminal.open(size),
    },
    terminalWrite: {
      args: z.tuple([hostParameterSchemas['terminal.write'].omit({ confirm: true })]),
      run: (request) => terminal.write(request),
    },
    terminalResize: {
      args: z.tuple([hostParameterSchemas['terminal.resize']]),
      run: (request) => terminal.resize(request),
    },
    terminalClose: {
      args: z.tuple([hostParameterSchemas['terminal.close'].omit({ confirm: true }).optional()]),
      run: (target) => terminal.close(target),
    },
    terminalRun: {
      args: z.tuple([hostParameterSchemas['terminal.run'].omit({ confirm: true })]),
      run: (request) => terminal.run(request),
    },
    terminalStop: {
      args: z.tuple([hostParameterSchemas['terminal.stop'].optional()]),
      run: (target) => terminal.stop(target),
    },
    firmwareChoosePath: {
      args: z.tuple([nativePath]),
      run: (file) => options.firmware.choose(absolute(file)),
    },
    firmwareExportPath: {
      args: z.tuple([
        z
          .object({
            format: z.enum(['bin', 'hex', 'srec', 'elf']),
            path: nativePath,
            confirmOverwrite: z.literal(true).optional(),
          })
          .strict(),
      ]),
      run: async (request) => {
        const destination = absolute(request.path);
        const stat = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (stat?.isSymbolicLink() || (stat && !request.confirmOverwrite))
          throw new Error('toast.fileExists');
        const prepared = await prepareBuildExport(
          core.currentProjectRoot(),
          await core.getState(),
          request.format,
        );
        const sidecar = prepared.manifest ? destination + '.' + Date.now() + '.json' : undefined;
        if (sidecar) await fs.writeFile(sidecar, prepared.manifest!, { flag: 'wx' });
        try {
          await fs.writeFile(destination, prepared.data, { flag: request.confirmOverwrite ? 'w' : 'wx' });
        } catch (error) {
          if (sidecar) await fs.unlink(sidecar).catch(() => {});
          throw error;
        }
        return { status: 'saved', path: destination };
      },
    },
    firmwareFlash: {
      args: z.tuple([
        z
          .object({
            id: z.string().min(1).max(128),
            config: configSchema,
            address: z.number().int().min(0).max(0xffffffff).optional(),
            confirm: z.literal(true),
          })
          .strict(),
      ]),
      run: (request) =>
        options.firmware.withImage(request.id, request.config.boardId, request.address, (image) =>
          core.flashPrepared(request.config, image),
        ),
    },
  };
  const rawGitAction = routes.gitAction.run;
  routes.gitAction.run = (request) => {
    if (!['stage', 'unstage', 'commit', 'checkout', 'createBranch', 'pull'].includes(request.action))
      return rawGitAction(request);
    return collaboration.workspaceAction(async () => {
      const result = await rawGitAction(request);
      if (['checkout', 'createBranch', 'pull'].includes(request.action)) await options.reloadProject?.();
      return result;
    });
  };
  const invoke = async (method: string, args: unknown[]) => {
    if (!Object.hasOwn(routes, method)) throw new Error('rpc.methodNotFound');
    const route = routes[method],
      parsed = route.args.safeParse(args);
    if (!parsed.success) throw new Error('rpc.invalidParams');
    return route.run(...(parsed.data as unknown[]));
  };
  const aliases: Record<string, [string, (params: any) => unknown[]]> = {
    'packages.inspect': ['packageInspect', (p) => [p]],
    'devices.openLocation': ['devicePackageOpenLocation', (p) => [p.id]],
    'devices.verify': ['devicePackagesVerify', (p) => [p.ids]],
    ...extensionRoutes.aliases,
    ...modelRoutes.aliases,
    'components.state': ['componentsState', () => []],
    'components.search': ['componentsSearch', (p) => [p.query]],
    'components.install': ['componentsInstall', (p) => [p]],
    'components.import': ['componentsImport', (p) => [p]],
    'components.remove': ['componentsRemove', (p) => [p]],
    'components.export': ['componentsExport', (p) => [p]],
    'tools.downloadVersion': ['toolVersionDownload', (p) => [p]],
    'tools.exportVersion': ['toolVersionExport', (p) => [p]],
    'tools.importVersion': ['toolVersionImport', (p) => [p]],
    'tools.cancelVersionTransfer': ['toolVersionCancel', () => []],
    'devices.packages': ['devicePackagesState', () => []],
    'devices.review': ['devicePackageReview', (p) => [p]],
    'devices.install': ['devicePackageInstall', (p) => [p]],
    'devices.export': ['devicePackageExport', (p) => [p]],
    'runtime.plugins': ['runtimePluginsState', () => []],
    'runtime.context': ['runtimePluginContext', (p) => [p.id]],
    'runtime.configure': ['runtimePluginConfigure', (p) => [p.id, p.value]],
    'runtime.device': ['runtimePluginDevice', (p) => [p.id, p.method, p.args, p.confirm]],
    'runtime.trust': ['runtimePluginTrust', (p) => [p]],
    'runtime.view': ['runtimePluginView', (p) => [p.id, p.kind]],
    'runtime.view.info': ['runtimePluginViewInfo', (p) => [p.id, p.viewId]],
    'runtime.debug': ['runtimePluginDebug', (p) => [p.id, p.method, p.args]],
    'language.index': ['languageIndex', () => []],
    'language.navigate': ['languageNavigate', (p) => [p]],
    'language.cancel': ['languageCancel', (p) => [p]],
    'language.openExternal': ['languageOpenExternal', (p) => [p]],
    'git.status': ['gitStatus', () => []],
    'git.diff': ['gitDiff', (p) => [p]],
    'git.action': ['gitAction', (p) => [p]],
    'tools.versions': ['toolVersionsState', () => []],
    'tools.installVersion': ['toolVersionInstall', (p) => [p]],
    'tools.selectVersion': ['toolVersionSelect', (p) => [p]],
    'host.browse': ['hostBrowse', (p) => (p.path ? [p.path] : [])],
    'vscode.open': ['vscodeOpen', (p) => [p]],
    'project.package.preview': ['projectPackagePreview', () => []],
    'project.package.export': ['projectPackageExport', (p) => [p]],
    'terminal.sessions': ['terminalSessions', () => []],
    'terminal.state': [
      'terminalState',
      (p) => [{ terminalId: p.terminalId, sessionId: p.sessionId, after: p.after }],
    ],
    'terminal.open': [
      'terminalOpen',
      (p) => [{ terminalId: p.terminalId, name: p.name, create: p.create, cols: p.cols, rows: p.rows }],
    ],
    'terminal.run': [
      'terminalRun',
      (p) => [{ terminalId: p.terminalId, sessionId: p.sessionId, command: p.command }],
    ],
    'terminal.stop': ['terminalStop', (p) => [{ terminalId: p.terminalId, sessionId: p.sessionId }]],
    'terminal.write': [
      'terminalWrite',
      (p) => [{ data: p.data, terminalId: p.terminalId, sessionId: p.sessionId }],
    ],
    'terminal.resize': [
      'terminalResize',
      (p) => [{ cols: p.cols, rows: p.rows, terminalId: p.terminalId, sessionId: p.sessionId }],
    ],
    'terminal.close': ['terminalClose', (p) => [{ terminalId: p.terminalId, sessionId: p.sessionId }]],
  };
  return {
    routes,
    invoke,
    packages: {
      download: async (id: string) => {
        try {
          return await delivery.download(id);
        } catch {
          try {
            return generalExtensions.download(id);
          } catch {
            try {
              return devicePackages.download(id);
            } catch {
              return packages.download(id);
            }
          }
        }
      },
    },
    generalExtensions,
    languageNavigation,
    terminal,
    model,
    git,
    tools,
    automationInvoke: (method: string, params: Record<string, unknown>) => {
      const entry = aliases[method];
      if (!entry) throw new Error('rpc.methodNotFound');
      return invoke(entry[0], entry[1](params));
    },
    close: async () => {
      languageServer.dispose();
      await clangd.dispose();
      languageNavigation.dispose();
      model.close();
      await Promise.allSettled([terminal.closeAll(), generalExtensions.close()]);
    },
  };
}
export type HostServices = ReturnType<typeof createHostServices>;
