import * as z from 'zod';
import type { HardwareDebugger } from './hardware-debugger';
import type { CoreService } from './service';
import { parseConfig, configSchema } from './config';
import {
  breakpointLocationsSchema,
  debuggerPatchSchema,
  debuggerAssembleSchema,
} from '../shared/debugger-edit';

/** Browser clients share the desktop debugger and its hardware lock; no native path API. */
export function createWebDebugger(debuggerService: HardwareDebugger, core: CoreService) {
  const routes: Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }> = {
    debuggerState: {
      args: z.tuple([configSchema.optional()]),
      run: (config) => debuggerService.state(config),
    },
    debuggerStorage: { args: z.tuple([]), run: () => debuggerService.storage() },
    debuggerSymbolsPath: {
      args: z.tuple([z.string().min(1).max(4096)]),
      run: async (file) => {
        let result = '';
        await core.runHardwareAction(async () => {
          result = await debuggerService.symbolsFile(file);
        });
        return result;
      },
    },
    debuggerChooseGdbPath: {
      args: z.tuple([z.string().min(1).max(4096)]),
      run: async (file) => {
        await debuggerService.selectGdb(file);
        return true;
      },
    },
    debuggerConnect: {
      args: z.tuple([z.unknown()]),
      run: (config) => core.runHardwareAction(() => debuggerService.connect(parseConfig(config))),
    },
    debuggerAction: {
      args: z.tuple([z.enum(['continue', 'pause', 'step', 'next', 'finish', 'disconnect'])]),
      run: (action) => debuggerService.action(action),
    },
    debuggerBreakpoint: {
      args: z.tuple([z.string().max(1024), z.string().regex(/^\d+$/).optional()]),
      run: (location, id) => debuggerService.breakpoint(location, id),
    },
    debuggerMemory: {
      args: z.tuple([z.number().int().min(0).max(0xffffffff), z.number().int().min(1).max(4096)]),
      run: (address, length) => debuggerService.memory(address, length),
    },
    debuggerBreakpoints: {
      args: z.tuple([breakpointLocationsSchema]),
      run: (locations) => debuggerService.breakpoints(locations),
    },
    debuggerPatch: {
      args: z.tuple([debuggerPatchSchema]),
      run: (request) => debuggerService.patch(request),
    },
    debuggerAssemble: {
      args: z.tuple([debuggerAssembleSchema.shape.address, debuggerAssembleSchema.shape.source]),
      run: (address, source) => debuggerService.assemble(address, source),
    },
    debuggerInstallTools: {
      args: z.tuple([configSchema.optional()]),
      run: (config) =>
        core.runInstallation('GDB / debug server', ({ progress, log, fetcher, signal }) =>
          debuggerService.install(progress, log, { fetcher, signal, config }),
        ),
    },
  };
  return {
    async invoke(method: string, args: unknown[]): Promise<unknown> {
      if (!Object.hasOwn(routes, method)) throw new Error('rpc.methodNotFound');
      const route = routes[method];
      const parsed = route.args.safeParse(args);
      if (!parsed.success) throw new Error('rpc.invalidParams');
      return route.run(...(parsed.data as unknown[]));
    },
    async symbols(bytes: Buffer, name: string): Promise<string> {
      let result = '';
      await core.runHardwareAction(async () => {
        result = await debuggerService.symbolsBytes(bytes, name);
      });
      return result;
    },
  };
}
