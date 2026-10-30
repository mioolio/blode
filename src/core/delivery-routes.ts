import * as z from 'zod';
import { ComponentPackages } from './component-package';
import { OfflineTools, type OfflineToolOptions } from './tool-offline';
import type { CoreService } from './service';
import { toolPackageFile } from './tool-package-store';
export const deliveryParameterSchemas = {
  'components.export': z
    .object({
      expectedProjectRoot: z.string().min(1).max(4096),
      ids: z.array(z.string().max(160)).max(128).optional(),
      confirm: z.literal(true),
    })
    .strict(),
  'tools.downloadVersion': z.object({ id: z.string().min(1).max(128), confirm: z.literal(true) }).strict(),
  'tools.importVersion': z.object({ path: z.string().min(1).max(4096), confirm: z.literal(true) }).strict(),
  'tools.cancelVersionTransfer': z.object({}).strict(),
};
export function createDeliveryRoutes(options: {
  dataRoot: string;
  projectRoot: () => string;
  savePackage?: (file: { path: string; name: string }) => Promise<boolean>;
  toolOptions: OfflineToolOptions;
  runInstallation: CoreService['runInstallation'];
}) {
  const components = new ComponentPackages(options);
  const archives = new Map<string, { path: string; name: string }>();
  let active: AbortController | undefined;
  const perform = async <T>(tool: string, run: (offline: OfflineTools) => Promise<T>) => {
    if (active) throw new Error('error.busy');
    const controller = new AbortController();
    active = controller;
    let result!: T;
    try {
      await options.runInstallation(tool, async (hooks) => {
        const signal = hooks.signal ? AbortSignal.any([controller.signal, hooks.signal]) : controller.signal;
        const offline = new OfflineTools({
          ...options.toolOptions,
          signal,
          fetcher: hooks.fetcher ?? options.toolOptions.fetcher,
          onProgress: hooks.progress,
          onLine: hooks.log,
        });
        result = await run(offline);
      });
      return result;
    } finally {
      if (active === controller) active = undefined;
    }
  };
  const artifact = async (id: string) => archives.get(id) ?? toolPackageFile(options.dataRoot, id);
  return {
    routes: {
      toolVersionDownload: {
        args: z.tuple([deliveryParameterSchemas['tools.downloadVersion']]),
        run: (request: z.infer<(typeof deliveryParameterSchemas)['tools.downloadVersion']>) =>
          perform(request.id, async (offline) => {
            const result = await offline.download(request);
            archives.set(result.id, offline.downloadFile(result.id));
            return result;
          }),
      },
      toolVersionImport: {
        args: z.tuple([deliveryParameterSchemas['tools.importVersion']]),
        run: (request: z.infer<(typeof deliveryParameterSchemas)['tools.importVersion']>) =>
          perform('offline-tool', (offline) => offline.install(request)),
      },
      toolVersionCancel: {
        args: z.tuple([]),
        run: async () => {
          active?.abort(new Error('error.operationCancelled'));
        },
      },
      toolVersionPackageSave: {
        args: z.tuple([z.string().uuid()]),
        run: async (id: string) => {
          if (!options.savePackage) throw new Error('rpc.desktopOnly');
          return options.savePackage(await artifact(id));
        },
      },
      componentsExport: {
        args: z.tuple([deliveryParameterSchemas['components.export']]),
        run: (request: z.infer<(typeof deliveryParameterSchemas)['components.export']>) =>
          components.export(request),
      },
      componentsPackageSave: {
        args: z.tuple([z.string().uuid()]),
        run: (id: string) => {
          if (!options.savePackage) throw new Error('rpc.desktopOnly');
          return options.savePackage(components.download(id));
        },
      },
    },
    download: async (id: string) => {
      try {
        return await artifact(id);
      } catch {
        return components.download(id);
      }
    },
  };
}
