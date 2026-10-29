import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CoreService } from './service';
import type { AiAssistance } from './ai-assistance';
import type { CollaborationService } from './collaboration';
import type { HardwareDebugger } from './hardware-debugger';
import type { RecentProjects } from './recent-projects';
import type { RecentLogs } from './recent-logs';
import type { UiCommands } from './ui-commands';
import { FirmwareStore, prepareBuildExport } from './firmware';
import {
  workbenchRouteSchemas,
  workbenchDescriptions,
  type WorkbenchRouteName,
} from '../automation/workbench-routes';
import { routeSchemas } from '../automation/routes';
import type { HostServices } from './host-services';
import { hostParameterSchemas } from './host-service-schemas';

interface Options {
  core: CoreService;
  ai: AiAssistance;
  collaboration: CollaborationService;
  debugger: HardwareDebugger;
  firmware: FirmwareStore;
  recent: RecentProjects;
  logs: RecentLogs;
  ui: UiCommands;
  hostServices?: HostServices;
  openDebugger(): Promise<unknown>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
}
const absolute = (value: string) => {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('error.invalidPath');
  return path.resolve(value);
};

/** Shared validated automation capability surface. No eval, shell, or renderer-selected native paths. */
export function createWorkbenchAutomation(options: Options) {
  const { core, ai, collaboration, debugger: debug, firmware, recent, logs, ui } = options;
  const handlers: Partial<Record<WorkbenchRouteName, (params: any) => unknown>> = {
    'capabilities.get': () => ({
      protocol: 1,
      methods: Object.keys(routeSchemas).map((method) => ({
        method,
        description: (workbenchDescriptions as Record<string, string>)[method] ?? method,
        confirmation: [
          'flash.run',
          'toolchain.install',
          'file.delete',
          'project.close',
          'drivers.install',
          'firmware.flash',
          'debugger.tools.install',
          'window.action',
          'tools.installVersion',
          'terminal.run',
          'git.action',
        ].includes(method),
      })),
      uiActions: [
        'home',
        'project',
        'view',
        'openFile',
        'closeFile',
        'pinFile',
        'preferences',
        'save',
        'console',
        'consolePanel',
        'devicePanel',
        'editor',
        'splitEditor',
        'language',
        'syncDrafts',
        'clearLogs',
      ],
    }),
    'file.create': (p) => core.createFile(p.path),
    'directory.create': (p) => core.createDirectory(p.path),
    'file.rename': (p) => core.renameEntry(p.from, p.to),
    'file.delete': (p) => core.deleteEntry(p.path),
    'project.open': async (p) => {
      if (ui.state().some((client) => !client.browser && client.dirtyFiles.length))
        await ui.command({ action: 'save' });
      await core.setProjectRoot(absolute(p.path));
      await recent.remember(p.path);
    },
    'project.close': async () => {
      if (ui.state().some((client) => !client.browser && client.dirtyFiles.length))
        await ui.command({ action: 'save' });
      await core.closeProject();
    },
    'recent.list': () => recent.list(),
    'recent.remove': (p) => recent.remove(absolute(p.path)),
    'drivers.status': (p) => core.driverStatuses(p.refresh),
    'drivers.install': (p) => core.installDriver(p.id),
    'firmware.prepare': (p) => firmware.choose(absolute(p.path)),
    'firmware.export': async (p) => {
      const destination = absolute(p.path);
      const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing?.isSymbolicLink() || (existing && !p.confirmOverwrite))
        throw new Error('toast.fileExists');
      const data = await prepareBuildExport(core.currentProjectRoot(), await core.getState(), p.format);
      // New sidecars never replace a previous export's address manifest.
      const manifest = data.manifest ? `${destination}.${Date.now()}.json` : undefined;
      if (manifest) await fs.writeFile(manifest, data.manifest!, { flag: 'wx' });
      try {
        await fs.writeFile(destination, data.data, { flag: p.confirmOverwrite ? 'w' : 'wx' });
      } catch (error) {
        if (manifest) await fs.unlink(manifest).catch(() => {});
        throw error;
      }
      return { path: destination, ...(manifest ? { manifest } : {}) };
    },
    'firmware.flash': (p) =>
      firmware.withImage(p.id, p.config.boardId, p.address, (image) => core.flashPrepared(p.config, image)),
    'debugger.state': () => debug.state(),
    'debugger.open': () => options.openDebugger(),
    'debugger.symbols.set': (p) =>
      core.runHardwareAction(async () => {
        await debug.symbolsFile(absolute(p.path));
      }),
    'debugger.connect': (p) => core.runHardwareAction(() => debug.connect(p.config)),
    'debugger.action': (p) => debug.action(p.action),
    'debugger.breakpoint': (p) => debug.breakpoint(p.location, p.removeId),
    'debugger.memory': (p) => debug.memory(p.address, p.length),
    'debugger.storage': () => debug.storage(),
    'debugger.tools.install': () =>
      core.runInstallation('GNU Arm GCC / GDB', ({ progress, log, fetcher, signal }) =>
        debug.install(progress, log, { fetcher, signal }),
      ),
    'debugger.gdb.set': (p) => debug.selectGdb(absolute(p.path)),
    'ui.state': () => ui.state(),
    'ui.command': (p) => ui.command(p),
    'window.action': (p) => options.windowAction(p.action),
    'logs.latest': () => logs.snapshot(),
    'collaboration.state': () => collaboration.state(),
    'collaboration.open': (p) => collaboration.open(p.projectRoot, p.path),
    'collaboration.presence': (p) => collaboration.presence(p),
    'collaboration.edit': (p) => collaboration.edit(p),
    'collaboration.undo': (p) => collaboration.undo(p, true),
    'collaboration.save': (p) => collaboration.save(p),
    'collaboration.resolve': (p) => collaboration.resolve(p),
    'collaboration.leave': (p) => collaboration.leave(p, true),
    'ai.state': () => ai.aiAssistanceState(),
    'ai.configure': (p) => ai.aiAssistanceConfigure(p),
    'ai.prediction.request': (p) => ai.aiPredictionRequest(p),
    'ai.prediction.cancel': (p) => ai.aiPredictionCancel(p),
    'ai.predictions.poll': (p) => ai.aiPredictionPoll(p),
    'ai.prediction.submit': (p) => ai.aiPredictionSubmit(p),
    'ai.prediction.read': (p) => ai.aiPredictionRead(p),
  };
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!Object.hasOwn(handlers, method) && !Object.hasOwn(hostParameterSchemas, method))
      throw new Error('rpc.methodNotFound');
    const key = method as WorkbenchRouteName;
    const parsed = workbenchRouteSchemas[key].safeParse(params);
    if (!parsed.success) throw new Error('rpc.invalidParams');
    if (Object.hasOwn(hostParameterSchemas, method)) {
      if (!options.hostServices) throw new Error('rpc.methodNotFound');
      return (
        (await options.hostServices.automationInvoke(method, parsed.data as Record<string, unknown>)) ?? null
      );
    }
    return (await handlers[key]!(parsed.data)) ?? null;
  };
}
