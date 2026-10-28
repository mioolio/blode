import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  connectionSchema,
  MAX_FRAME_BYTES,
  MAX_RESULT_BYTES,
  REQUEST_TIMEOUT_MS,
  RpcError,
  type RpcResponse,
} from './protocol';

/** The override also supports parallel profiles and a non-default Electron userData path. */
export function defaultConnectionFile(): string {
  if (process.env.BLODE_CONNECTION_FILE) return path.resolve(process.env.BLODE_CONNECTION_FILE);
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'Blode Studio', 'automation', 'connection.json');
}

export class PipeClient {
  constructor(private readonly connectionFile = defaultConnectionFile()) {}

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS + 5000,
  ): Promise<unknown> {
    const connection = connectionSchema.parse(JSON.parse(await readFile(this.connectionFile, 'utf8')));
    // Read the credential anew for every connection; the app rotates it on each launch.
    const token = (await readFile(connection.tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new RpcError(-32001, 'rpc.invalidCredential');
    const id = randomUUID();
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params, auth: token })}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new RpcError(-32005, 'rpc.limitExceeded');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(connection.endpoint);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error, result?: unknown): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => socket.write(frame));
      socket.once('timeout', () => finish(new RpcError(-32002, 'rpc.timeout')));
      socket.once('error', (error) => finish(error));
      socket.once('close', () => {
        if (!settled) finish(new RpcError(-32003, 'rpc.connectionClosed'));
      });
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength > MAX_RESULT_BYTES) {
          finish(new RpcError(-32006, 'rpc.resultTooLarge'));
          return;
        }
        const newline = buffer.indexOf(10);
        if (newline === -1) return;
        try {
          const response = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as RpcResponse;
          if (response.jsonrpc !== '2.0' || response.id !== id)
            throw new RpcError(-32600, 'rpc.invalidResponse');
          if ('error' in response)
            finish(new RpcError(response.error.code, response.error.message, response.error.data));
          else if ('result' in response) finish(undefined, response.result);
          else throw new RpcError(-32600, 'rpc.invalidResponse');
        } catch (error) {
          finish(error instanceof Error ? error : new RpcError(-32700, 'rpc.parseError'));
        }
      });
    });
  }
}
