import * as z from 'zod';
import type { CoreApi, LogEvent } from '../shared/contracts';
import { configSchema } from '../core/config-schema';
import { RpcError } from './protocol';
import { workbenchRouteSchemas } from './workbench-routes';
import { workspaceAssetRequestSchema } from '../core/workspace-asset-schema';

const empty = z.object({}).strict();
const port = z.string().min(1).max(256).optional();
const filePath = z.string().min(1).max(1024);

/** One schema map powers both the named-pipe and the MCP tool catalog. */
export const routeSchemas = {
  ...workbenchRouteSchemas,
  'state.get': empty,
  'ports.list': empty,
  'probes.list': empty,
  'devices.scan': empty,
  'project.readFile': z.object({ path: filePath }).strict(),
  'project.asset': workspaceAssetRequestSchema,
  'file.write': z.object({ path: filePath, content: z.string().max(1_000_000) }).strict(),
  'config.set': z.object({ config: configSchema }).strict(),
  'build.entry.set': z.object({ path: filePath }).strict(),
  'build.run': z
    .object({
      targetId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
        .optional(),
    })
    .strict(),
  'flash.run': z.object({ confirm: z.literal(true) }).strict(),
  'device.probe': z.object({ port, config: configSchema.optional() }).strict(),
  'toolchain.install': z.object({ confirm: z.literal(true) }).strict(),
  'serial.open': z
    .object({
      port,
      baudRate: z.number().int().min(110).max(4_000_000).optional(),
      options: z
        .object({
          dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
          parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
          stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
          flowControl: z.enum(['none', 'rtscts', 'xonxoff']).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'serial.close': empty,
  'serial.write': z
    .object({ data: z.string().max(65_536), encoding: z.enum(['utf8', 'hex']).optional() })
    .strict(),
  'events.poll': z.object({ after: z.number().int().nonnegative().optional() }).strict(),
} as const;
export type RouteName = keyof typeof routeSchemas;

export interface EventEntry {
  sequence: number;
  event: LogEvent;
}
export class EventBuffer {
  private sequence = 0;
  private entries: EventEntry[] = [];
  publish(event: LogEvent): void {
    this.entries.push({
      sequence: ++this.sequence,
      event: { ...event, message: event.message.slice(0, 8192) },
    });
    if (this.entries.length > 256) this.entries.shift();
  }
  poll(after = 0): { cursor: number; dropped: boolean; events: EventEntry[] } {
    return {
      cursor: this.sequence,
      dropped: after > this.sequence || (after > 0 && after < (this.entries[0]?.sequence ?? 1) - 1),
      events: this.entries.filter((entry) => entry.sequence > after),
    };
  }
}

export async function dispatch(
  api: CoreApi,
  events: EventBuffer,
  method: string,
  input: unknown,
): Promise<unknown> {
  if (!Object.hasOwn(routeSchemas, method)) throw new RpcError(-32601, 'rpc.methodNotFound');
  const schema = routeSchemas[method as RouteName];
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success)
    throw new RpcError(
      -32602,
      'rpc.invalidParams',
      parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    );
  // Re-parse individual branches to keep the schema-to-argument relationship explicit.
  switch (method as RouteName) {
    case 'state.get':
      return api.getState();
    case 'ports.list':
      return api.listPorts();
    case 'probes.list':
      return api.listDebugProbes();
    case 'devices.scan':
      return api.scanDevices();
    case 'project.readFile': {
      const { path } = routeSchemas['project.readFile'].parse(input);
      const normalized = path.replaceAll('\\', '/');
      if (
        normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '') ||
        normalized.includes(':')
      )
        throw new RpcError(-32602, 'rpc.invalidPath');
      const file = (await api.getState()).files.find(
        (entry) => entry.path.replaceAll('\\', '/') === normalized,
      );
      if (!file) throw new RpcError(-32004, 'rpc.fileNotFound');
      return file;
    }
    case 'project.asset':
      return api.workspaceAsset(routeSchemas['project.asset'].parse(input));
    case 'file.write': {
      const params = routeSchemas['file.write'].parse(input);
      await api.saveFile(params.path, params.content);
      return null;
    }
    case 'config.set': {
      await api.saveConfig(routeSchemas['config.set'].parse(input).config);
      return null;
    }
    case 'build.entry.set': {
      await api.setBuildEntry(routeSchemas['build.entry.set'].parse(input).path);
      return null;
    }
    case 'build.run':
      return api.build(routeSchemas['build.run'].parse(input ?? {}).targetId);
    case 'flash.run':
      await api.flash();
      return null;
    case 'device.probe': {
      const { port, config } = routeSchemas['device.probe'].parse(input ?? {});
      return api.probe(port, config);
    }
    case 'toolchain.install':
      return api.installToolchain();
    case 'serial.open': {
      const params = routeSchemas['serial.open'].parse(input ?? {});
      await api.serialOpen(params.port, params.baudRate, params.options);
      return null;
    }
    case 'serial.close':
      await api.serialClose();
      return null;
    case 'serial.write':
      {
        const request = routeSchemas['serial.write'].parse(input);
        await api.serialWrite(request.data, request.encoding);
      }
      return null;
    case 'events.poll':
      return events.poll(routeSchemas['events.poll'].parse(input ?? {}).after);
    default:
      if (!api.automationInvoke) throw new RpcError(-32601, 'rpc.methodNotFound');
      return api.automationInvoke(method, parsed.data as Record<string, unknown>);
  }
}
