import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import type { LogEvent } from '../shared/contracts';
import type { CoreService } from './service';
import type { CollaborationService } from './collaboration';
import type { RecentProjects } from './recent-projects';
import { FirmwareStore, prepareBuildExport } from './firmware';
import { GitService, createGitRoutes } from './git';
import { ToolVersions } from './tool-versions';
import { ProjectPackages } from './project-package';
import { HostTerminal } from './terminal';
import { browseHost } from './host-files';
import { runCommand } from './process';
import { configSchema, parseProjectBuild } from './config';
import { toolVersionSchemas } from './tool-version-schemas';
import { hostParameterSchemas } from './host-service-schemas';
import { LanguageIndexService } from './language-index';

interface Options {
  core: CoreService;
  collaboration: CollaborationService;
  firmware: FirmwareStore;
  recent: RecentProjects;
  dataRoot: string;
  toolchainRoot: string;
  emit: (event: LogEvent) => void;
  fetcher?: typeof fetch;
  toolchainEnv?: NodeJS.ProcessEnv;
  reloadProject?: () => Promise<void>;
  savePackage?: (file: { path: string; name: string }) => Promise<boolean>;
}
const absolute = (value: string) => {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('error.invalidPath');
  return path.resolve(value);
};
/** One validated capability registry shared by IPC, HTTP and trusted local AI. */
export function createHostServices(options: Options) {
  const { core, collaboration } = options;
  const language = new LanguageIndexService(core);
  const git = new GitService({ projectRoot: () => core.currentProjectRoot(), emit: options.emit });
  const terminal = new HostTerminal({ projectRoot: () => core.currentProjectRoot(), emit: options.emit });
  const packages = new ProjectPackages({
    dataRoot: options.dataRoot,
    projectRoot: () => core.currentProjectRoot(),
  });
  const toolRunner: typeof runCommand = (command, args, settings = {}) =>
    runCommand(command, args, { ...settings, env: { ...options.toolchainEnv, ...settings.env } });
  const toolOptions = {
    root: options.toolchainRoot,
    dataRoot: options.dataRoot,
    config: () => core.currentConfig(),
    build: async () => {
      const marker = (await core.workspaceSnapshot()).files.find((file) => file.path === 'be');
      if (!marker?.content.trim()) return {};
      try {
        return parseProjectBuild(JSON.parse(marker.content).build);
      } catch {
        return {};
      }
    },
    runner: toolRunner,
    env: options.toolchainEnv,
    fetcher: options.fetcher,
  };
  const tools = new ToolVersions(toolOptions);
  const noArgs = z.tuple([]),
    nativePath = z.string().min(1).max(4096);
  const routes: Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }> = {
    languageIndex: { args: noArgs, run: () => language.snapshot() },
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
        return tools.toolVersionsState();
      },
    },
    hostBrowse: { args: z.tuple([nativePath.optional()]), run: (directory) => browseHost(directory) },
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
    terminalState: { args: noArgs, run: () => terminal.state() },
    terminalRun: {
      args: z.tuple([z.object({ command: z.string().trim().min(1).max(16384) }).strict()]),
      run: (request) => terminal.run(request.command),
    },
    terminalStop: { args: noArgs, run: () => terminal.stop() },
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
    'language.index': ['languageIndex', () => []],
    'git.status': ['gitStatus', () => []],
    'git.diff': ['gitDiff', (p) => [p]],
    'git.action': ['gitAction', (p) => [p]],
    'tools.versions': ['toolVersionsState', () => []],
    'tools.installVersion': ['toolVersionInstall', (p) => [p]],
    'tools.selectVersion': ['toolVersionSelect', (p) => [p]],
    'host.browse': ['hostBrowse', (p) => (p.path ? [p.path] : [])],
    'project.package.preview': ['projectPackagePreview', () => []],
    'project.package.export': ['projectPackageExport', (p) => [p]],
    'terminal.state': ['terminalState', () => []],
    'terminal.run': ['terminalRun', (p) => [{ command: p.command }]],
    'terminal.stop': ['terminalStop', () => []],
  };
  return {
    routes,
    invoke,
    packages,
    terminal,
    git,
    tools,
    automationInvoke: (method: string, params: Record<string, unknown>) => {
      const entry = aliases[method];
      if (!entry) throw new Error('rpc.methodNotFound');
      return invoke(entry[0], entry[1](params));
    },
    close: () => terminal.close(),
  };
}
export type HostServices = ReturnType<typeof createHostServices>;
