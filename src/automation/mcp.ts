import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PipeClient } from './client';
import { routeSchemas, type RouteName } from './routes';
import { RpcError } from './protocol';
import { workbenchDescriptions } from './workbench-routes';
import { RELEASE_VERSION } from '../shared/version';
import zh from './locales/zh-CN.json';
import en from './locales/en-US.json';

const readOnly = new Set<RouteName>([
  'state.get',
  'ports.list',
  'probes.list',
  'devices.scan',
  'project.readFile',
  'events.poll',
  'capabilities.get',
  'recent.list',
  'drivers.status',
  'debugger.state',
  'debugger.memory',
  'debugger.storage',
  'ui.state',
  'logs.latest',
  'collaboration.state',
  'collaboration.open',
  'ai.state',
  'ai.predictions.poll',
  'ai.prediction.read',
  'git.status',
  'git.diff',
  'tools.versions',
  'host.browse',
  'project.package.preview',
  'terminal.state',
]);
const destructive = new Set<RouteName>([
  'flash.run',
  'file.write',
  'config.set',
  'build.entry.set',
  'serial.write',
  'file.delete',
  'file.rename',
  'firmware.flash',
  'project.close',
  'window.action',
  'collaboration.resolve',
  'collaboration.undo',
  'git.action',
  'terminal.run',
]);

/** MCP is only a transport adapter: it calls the same validated pipe routes as any AI. */
export function createMcpServer(client = new PipeClient(), language = process.env.BLODE_LANG): McpServer {
  const strings = language === 'en-US' ? en : zh;
  const server = new McpServer(
    { name: 'blode-studio', version: RELEASE_VERSION },
    { maxToolInputElements: 4096 },
  );
  const register = (method: RouteName): void => {
    server.registerTool(
      `blode_${method.replaceAll('.', '_')}`,
      {
        description:
          (strings as Record<string, string>)[method] ??
          (workbenchDescriptions as Record<string, string>)[method] ??
          method,
        inputSchema: routeSchemas[method],
        annotations: {
          readOnlyHint: readOnly.has(method),
          destructiveHint: destructive.has(method),
          idempotentHint: readOnly.has(method) || method === 'serial.close' || method === 'build.entry.set',
          openWorldHint: [
            'toolchain.install',
            'drivers.install',
            'debugger.tools.install',
            'tools.installVersion',
            'git.action',
            'terminal.run',
          ].includes(method),
        },
      },
      async (params: Record<string, unknown>) => {
        try {
          const result = await client.request(method, params as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const detail =
            error instanceof RpcError
              ? { code: error.code, message: error.message, data: error.data }
              : {
                  message: strings['bridge.failed'],
                  reason: error instanceof Error ? error.message : 'unknown',
                };
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(detail) }] };
        }
      },
    );
  };
  for (const method of Object.keys(routeSchemas) as RouteName[]) register(method);
  return server;
}
