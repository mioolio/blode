import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createMcpServer } from '../src/automation/mcp';
import { PipeClient, defaultConnectionFile } from '../src/automation/client';

export async function runBridge(args = process.argv.slice(2)): Promise<void> {
  const connectionIndex = args.indexOf('--connection');
  if (connectionIndex >= 0 && !args[connectionIndex + 1]) throw new Error('rpc.missingConnectionArgument');
  const file = connectionIndex >= 0 ? path.resolve(args[connectionIndex + 1]) : defaultConnectionFile();
  const server = createMcpServer(new PipeClient(file));
  const transport = new StdioServerTransport(undefined, undefined, { maxBufferSize: 2 * 1024 * 1024 });
  await server.connect(transport);
  const stop = (): void => {
    void server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBridge().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'rpc.bridgeFailed'}\n`);
    process.exitCode = 1;
  });
}
