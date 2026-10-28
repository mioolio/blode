import { z } from 'zod';
import type { CoreApi, LogEvent } from '../shared/contracts';
import { configSchema } from '../core/config';
import { RpcError } from './protocol';

const empty = z.object({}).strict();
const port = z.string().min(1).max(256).optional();
const filePath = z.string().min(1).max(1024);

/** One schema map powers both the named-pipe and the MCP tool catalog. */
export const routeSchemas = {
  'state.get': empty,
  'ports.list': empty,
  'probes.list': empty,
  'devices.scan': empty,
  'project.readFile': z.object({ path: filePath }).strict(),
  'file.write': z.object({ path: filePath, content: z.string().max(1_000_000) }).strict(),
  'config.set': z.object({ config: configSchema }).strict(),
  'build.entry.set': z.object({ path: filePath }).strict(),
  'build.run': empty,
  'flash.run': z.object({ confirm: z.literal(true) }).strict(),
  'device.probe': z.object({ port, config: configSchema.optional() }).strict(),
  'toolchain.install': z.object({ confirm: z.literal(true) }).strict(),
  'serial.open': z.object({ port, baudRate: z.number().int().min(300).max(3_000_000).optional() }).strict(),
  'serial.close': empty,
  'serial.write': z.object({ data: z.string().max(65_536) }).strict(),
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
      return api.build();
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
      await api.serialOpen(params.port, params.baudRate);
      return null;
    }
    case 'serial.close':
      await api.serialClose();
      return null;
    case 'serial.write':
      await api.serialWrite(routeSchemas['serial.write'].parse(input).data);
      return null;
    case 'events.poll':
      return events.poll(routeSchemas['events.poll'].parse(input ?? {}).after);
  }
}
