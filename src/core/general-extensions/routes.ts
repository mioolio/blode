import * as z from 'zod';
import { GeneralExtensions } from './index';
import { generalExtensionParameterSchemas as schemas } from './schema';

export function createGeneralExtensionRoutes(
  extensions: GeneralExtensions,
  save?: (file: { path: string; name: string }) => Promise<boolean>,
  viewUrl?: (id: string, view: string) => string,
) {
  return {
    routes: {
      generalExtensionState: { args: z.tuple([]), run: () => extensions.state() },
      generalExtensionReview: {
        args: z.tuple([schemas['extensions.review']]),
        run: (request: z.infer<(typeof schemas)['extensions.review']>) => extensions.review(request),
      },
      generalExtensionInstall: {
        args: z.tuple([schemas['extensions.install']]),
        run: (request: z.infer<(typeof schemas)['extensions.install']>) => extensions.install(request),
      },
      generalExtensionEnable: {
        args: z.tuple([schemas['extensions.enable']]),
        run: (request: z.infer<(typeof schemas)['extensions.enable']>) => extensions.enable(request),
      },
      generalExtensionDisable: {
        args: z.tuple([schemas['extensions.disable']]),
        run: (request: z.infer<(typeof schemas)['extensions.disable']>) => extensions.disable(request),
      },
      generalExtensionRemove: {
        args: z.tuple([schemas['extensions.remove']]),
        run: (request: z.infer<(typeof schemas)['extensions.remove']>) => extensions.remove(request),
      },
      generalExtensionConfigure: {
        args: z.tuple([schemas['extensions.configure']]),
        run: (request: z.infer<(typeof schemas)['extensions.configure']>) => extensions.configure(request),
      },
      generalExtensionExport: {
        args: z.tuple([schemas['extensions.export']]),
        run: (request: z.infer<(typeof schemas)['extensions.export']>) => extensions.export(request),
      },
      generalExtensionPackageSave: {
        args: z.tuple([z.string().uuid()]),
        run: (id: string) => {
          if (!save) throw new Error('rpc.desktopOnly');
          return save(extensions.download(id));
        },
      },
      generalExtensionViewDocument: {
        args: z.tuple([schemas['extensions.view']]),
        run: (request: z.infer<(typeof schemas)['extensions.view']>) => extensions.viewDocument(request),
      },
      generalExtensionViewUrl: {
        args: z.tuple([schemas['extensions.viewUrl']]),
        run: async (request: z.infer<(typeof schemas)['extensions.viewUrl']>) => {
          // Check the enabled package and declared view before exposing its document URL.
          await extensions.viewDocument(request);
          if (!viewUrl) throw new Error('rpc.desktopOnly');
          return viewUrl(request.id, request.view);
        },
      },
      generalExtensionOpenView: {
        args: z.tuple([schemas['extensions.openView']]),
        run: (request: z.infer<(typeof schemas)['extensions.openView']>) => extensions.openView(request),
      },
      generalExtensionContext: {
        args: z.tuple([schemas['extensions.context']]),
        run: (request: z.infer<(typeof schemas)['extensions.context']>) => extensions.context(request),
      },
    },
    aliases: Object.fromEntries(
      Object.keys(schemas).map((method) => {
        const suffix = method.slice('extensions.'.length),
          api =
            suffix === 'state'
              ? 'State'
              : suffix === 'view'
                ? 'ViewDocument'
                : suffix[0].toUpperCase() + suffix.slice(1);
        return [
          method,
          [
            `generalExtension${api}`,
            (params: Record<string, unknown>) => (suffix === 'state' ? [] : [params]),
          ],
        ] as const;
      }),
    ) as Record<string, [string, (params: Record<string, unknown>) => unknown[]]>,
  };
}
