import net, { type Socket } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rename, chmod, unlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CoreApi, LogEvent } from '../shared/contracts';
import { dispatch, EventBuffer } from './routes';
import {
  requestSchema,
  errorResponse,
  RpcError,
  MAX_CONNECTIONS,
  MAX_FRAME_BYTES,
  MAX_QUEUED_REQUESTS,
  MAX_RESULT_BYTES,
  REQUEST_TIMEOUT_MS,
  type RpcResponse,
  type ConnectionInfo,
} from './protocol';

export interface PipeServerOptions {
  api: CoreApi;
  dataRoot: string;
  onEvent?: (event: LogEvent) => void;
}
export interface PipeServerHandle {
  endpoint: string;
  tokenFile: string;
  connectionFile: string;
  publish(event: LogEvent): void;
  close(): Promise<void>;
}

/** Restrict the credential file to the current user, including on Windows. */
async function restrictCredential(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
    return;
  }
  const run = promisify(execFile);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const { stdout } = await run(path.join(systemRoot, 'System32', 'whoami.exe'), [], { windowsHide: true });
  const account = stdout.trim();
  if (!account || /[\r\n]/.test(account)) throw new Error('rpc.credentialAccount');
  await run(
    path.join(systemRoot, 'System32', 'icacls.exe'),
    // Modify includes DELETE: atomic rename and shutdown cleanup need it when
    // the parent directory does not grant DeleteChild. Read/write alone fails.
    [file, '/inheritance:r', '/grant:r', `${account}:(M)`],
    { windowsHide: true },
  );
}

async function atomicPrivateWrite(file: string, data: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await restrictCredential(temporary);
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function removeStaleUnixSocket(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return;
  const stat = await lstat(endpoint).catch(() => null);
  if (!stat) return;
  if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('rpc.endpointOccupied');
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('rpc.endpointBusy'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error('rpc.endpointBusy');
  await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function equalToken(received: string, expected: Buffer): boolean {
  if (!/^[a-f0-9]{64}$/.test(received)) return false;
  const candidate = Buffer.from(received, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function startPipeServer({
  api,
  dataRoot,
  onEvent,
}: PipeServerOptions): Promise<PipeServerHandle> {
  const directory = path.join(path.resolve(dataRoot), 'automation');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const suffix = createHash('sha256').update(directory).digest('hex').slice(0, 16);
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\blode-${suffix}`
      : path.join(tmpdir(), `blode-${process.getuid?.() ?? 'user'}-${suffix}.sock`);
  const tokenFile = path.join(directory, 'token');
  const connectionFile = path.join(directory, 'connection.json');
  const token = randomBytes(32);
  const events = new EventBuffer();
  const sockets = new Set<Socket>();
  let closed = false;
  let ready = false;

  const server = net.createServer((socket) => {
    if (!ready || closed || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let queued: string[] = [];
    let processing = false;
    let failedAuth = false;
    socket.setTimeout(60_000);
    socket.on('timeout', () => {
      if (!processing) socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      queued = [];
    });

    const send = (response: RpcResponse): void => {
      if (socket.destroyed) return;
      let frame = `${JSON.stringify(response)}\n`;
      if (Buffer.byteLength(frame) > MAX_RESULT_BYTES)
        frame = `${JSON.stringify(errorResponse(response.id, new RpcError(-32006, 'rpc.resultTooLarge')))}\n`;
      if (socket.writableLength + Buffer.byteLength(frame) > MAX_RESULT_BYTES * 2) {
        socket.destroy();
        return;
      }
      socket.write(frame);
    };

    const drain = async (): Promise<void> => {
      if (processing) return;
      processing = true;
      try {
        while (queued.length && !socket.destroyed && !failedAuth) {
          const frame = queued.shift()!;
          let value: unknown;
          try {
            value = JSON.parse(frame);
          } catch {
            send(errorResponse(null, new RpcError(-32700, 'rpc.parseError')));
            continue;
          }
          const parsed = requestSchema.safeParse(value);
          if (!parsed.success) {
            send(errorResponse(null, new RpcError(-32600, 'rpc.invalidRequest')));
            continue;
          }
          const request = parsed.data;
          if (!equalToken(request.auth, token)) {
            send(errorResponse(request.id ?? null, new RpcError(-32001, 'rpc.unauthorized')));
            failedAuth = true;
            socket.end();
            break;
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const operation = dispatch(api, events, request.method, request.params);
            const result = await Promise.race([
              operation,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new RpcError(-32002, 'rpc.timeout')), REQUEST_TIMEOUT_MS);
                timeout.unref();
              }),
            ]);
            if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result: result ?? null });
          } catch (error) {
            if (request.id !== undefined) {
              const failure =
                error instanceof RpcError
                  ? error
                  : new RpcError(-32000, 'rpc.operationFailed', {
                      reason: error instanceof Error ? error.message.slice(0, 4096) : 'unknown',
                    });
              send(errorResponse(request.id, failure));
            }
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        }
      } finally {
        processing = false;
        if (!socket.destroyed) socket.setTimeout(60_000);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (failedAuth) return;
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (newline > MAX_FRAME_BYTES || queued.length >= MAX_QUEUED_REQUESTS) {
          failedAuth = true;
          queued = [];
          buffer = Buffer.alloc(0);
          send(errorResponse(null, new RpcError(-32005, 'rpc.limitExceeded')));
          socket.end();
          return;
        }
        const frame = buffer.subarray(0, newline).toString('utf8').trim();
        buffer = buffer.subarray(newline + 1);
        if (frame) queued.push(frame);
      }
      if (buffer.byteLength > MAX_FRAME_BYTES) {
        failedAuth = true;
        queued = [];
        buffer = Buffer.alloc(0);
        send(errorResponse(null, new RpcError(-32005, 'rpc.limitExceeded')));
        socket.end();
        return;
      }
      void drain();
    });
  });

  await removeStaleUnixSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) =>
    onEvent?.({
      kind: 'log',
      level: 'error',
      message: `rpc.serverError: ${error.message}`,
      time: new Date().toISOString(),
    }),
  );
  try {
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
    // Bind first: a second instance must never overwrite the first instance's credential.
    await atomicPrivateWrite(tokenFile, `${token.toString('hex')}\n`);
    const info: ConnectionInfo = { version: 1, endpoint, tokenFile, pid: process.pid };
    await atomicPrivateWrite(connectionFile, `${JSON.stringify(info, null, 2)}\n`);
    ready = true;
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    endpoint,
    tokenFile,
    connectionFile,
    publish: (event) => events.publish(event),
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([unlink(connectionFile).catch(() => {}), unlink(tokenFile).catch(() => {})]);
    },
  };
}
