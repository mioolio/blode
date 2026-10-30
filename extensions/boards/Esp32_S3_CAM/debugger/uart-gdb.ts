import net from 'node:net';
import type { Duplex } from 'node:stream';
import { SerialPort } from 'serialport';

export type UartGdbSerial = Duplex & {
  readonly isOpen: boolean;
  open(callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
};
export interface UartGdbBridge {
  port: number;
  close(): Promise<void>;
}
export interface UartGdbOptions {
  port: string;
  baudRate: number;
  stubMode: 'runtime' | 'panic';
  signal?: AbortSignal;
  timeoutMs?: number;
  onDiagnostic?: (line: string) => void;
  onError?: (error: Error) => void;
  createSerial?: (port: string, baudRate: number) => UartGdbSerial;
}

export function validateUartGdbOptions(options: Pick<UartGdbOptions, 'port' | 'baudRate' | 'stubMode'>) {
  if (
    typeof options.port !== 'string' ||
    options.port.length > 256 ||
    !/^(?:COM[1-9]\d*|\/dev\/[A-Za-z0-9._/-]+)$/i.test(options.port) ||
    options.port.split('/').includes('..')
  )
    throw new Error('error.debuggerUartPort');
  if (!Number.isInteger(options.baudRate) || options.baudRate < 110 || options.baudRate > 4_000_000)
    throw new Error('error.invalidBaudRate');
  if (!['runtime', 'panic'].includes(options.stubMode)) throw new Error('error.invalidArguments');
}

/** Locate a complete, checksum-verified RSP stop reply, never ordinary serial output. */
export function uartGdbStopPacket(bytes: Buffer): number {
  // Scan once and resynchronize at '$'; noisy firmware must not cause quadratic scans.
  let start = -1;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] === 0x24) {
      start = end;
      continue;
    }
    if (bytes[end] !== 0x23 || start < 0) continue;
    const packetStart = start;
    start = -1;
    if (end + 2 >= bytes.length || end - packetStart > 4096) continue;
    const body = bytes.subarray(packetStart + 1, end);
    if (!/^(?:S[0-9a-f]{2}|T[0-9a-f]{2}(?:[0-9a-z:;.,_+-]*))$/i.test(body.toString('utf8'))) continue;
    const checksum = bytes.subarray(end + 1, end + 3).toString('utf8');
    if (!/^[0-9a-f]{2}$/i.test(checksum)) continue;
    if ((body.reduce((sum, byte) => sum + byte, 0) & 0xff) === Number.parseInt(checksum, 16))
      return packetStart;
  }
  return -1;
}

/** One local GDB client owns a byte-transparent serial connection; no reset-line operations. */
export async function openUartGdbBridge(options: UartGdbOptions): Promise<UartGdbBridge> {
  validateUartGdbOptions(options);
  if (options.signal?.aborted) throw new Error('error.operationCancelled');
  const limit = 1024 * 1024;
  const serial = (
    options.createSerial ??
    ((port, baudRate) =>
      new SerialPort({
        path: port,
        baudRate,
        autoOpen: false,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        rtscts: false,
        xon: false,
        xoff: false,
        lock: true,
        hupcl: false,
      }))
  )(options.port, options.baudRate);
  const server = net.createServer();
  let socket: net.Socket | undefined;
  let accepted = false;
  let closed = false;
  let stopping: Promise<void> | undefined;
  let ready = false;
  let returned = false;
  let handshake = Buffer.alloc(0);
  let buffered = Buffer.alloc(0);
  let totalBeforeStop = 0;
  let stopQueryTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: Error | undefined;
  let openStarted = false;
  let settleOpen!: () => void;
  const openingSettled = new Promise<void>((resolve) => {
    settleOpen = resolve;
  });
  let failReady!: (error: Error) => void;
  let finishReady!: () => void;
  const stopReply = new Promise<void>((resolve, reject) => {
    finishReady = resolve;
    failReady = reject;
  });
  // The serial open callback may settle after cancellation; keep this promise observed meanwhile.
  void stopReply.catch(() => {});
  const timeout = setTimeout(
    () => fail(new Error('error.debuggerUartStubTimeout')),
    options.timeoutMs ?? 6000,
  );
  const cancelled = () => fail(new Error('error.operationCancelled'));
  function fail(error: Error) {
    if (closed) return;
    failure ??= error;
    failReady(failure);
    if (returned) options.onError?.(failure);
    void close();
  }
  function close(): Promise<void> {
    if (stopping) return stopping;
    closed = true;
    clearTimeout(timeout);
    clearTimeout(stopQueryTimer);
    options.signal?.removeEventListener('abort', cancelled);
    socket?.destroy();
    stopping = (async () => {
      await Promise.all([
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
        (async () => {
          if (openStarted) await openingSettled;
          await new Promise<void>((resolve) => {
            if (!serial.isOpen) {
              serial.destroy();
              resolve();
              return;
            }
            serial.close(() => {
              serial.destroy();
              resolve();
            });
          });
        })(),
      ]);
    })();
    return stopping;
  }
  options.signal?.addEventListener('abort', cancelled, { once: true });
  serial.on('error', (error) => fail(error));
  serial.on('close', () => {
    if (!closed) fail(new Error('error.debuggerUartClosed'));
  });
  serial.on('data', (chunk: Buffer) => {
    if (closed) return;
    let bytes = Buffer.from(chunk);
    if (!ready) {
      totalBeforeStop += bytes.length;
      if (totalBeforeStop > limit) {
        fail(new Error('error.debuggerUartOverflow'));
        return;
      }
      handshake = Buffer.concat([handshake, bytes]).subarray(-65536);
      const start = uartGdbStopPacket(handshake);
      if (start < 0) return;
      bytes = handshake.subarray(start);
      handshake = Buffer.alloc(0);
      ready = true;
      clearTimeout(timeout);
      clearTimeout(stopQueryTimer);
      options.onDiagnostic?.('UART GDB Stub: received a valid stop reply.');
      finishReady();
    }
    if (socket) {
      if (socket.writableLength + bytes.length > limit) {
        fail(new Error('error.debuggerUartOverflow'));
        return;
      }
      if (!socket.write(bytes)) serial.pause();
    } else {
      if (buffered.length + bytes.length > limit) {
        fail(new Error('error.debuggerUartOverflow'));
        return;
      }
      buffered = Buffer.concat([buffered, bytes]);
    }
  });
  server.on('error', (error) => fail(error));
  server.on('connection', (client) => {
    if (closed || accepted) {
      client.on('error', () => {});
      client.destroy();
      return;
    }
    accepted = true;
    socket = client;
    client.setNoDelay(true);
    client.on('error', (error) => fail(error));
    client.on('close', () => {
      if (!closed) fail(new Error('error.debuggerUartClosed'));
    });
    client.on('drain', () => serial.resume());
    client.on('data', (bytes) => {
      if (closed) return;
      if (serial.writableLength + bytes.length > limit) {
        fail(new Error('error.debuggerUartOverflow'));
        return;
      }
      if (
        !serial.write(bytes, (error) => {
          if (error) fail(error);
        })
      )
        client.pause();
    });
    serial.on('drain', () => client.resume());
    if (buffered.length) {
      if (!client.write(buffered)) serial.pause();
      buffered = Buffer.alloc(0);
    }
  });
  try {
    openStarted = true;
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        try {
          serial.open((error) => {
            settleOpen();
            if (closed) {
              reject(failure ?? new Error('error.operationCancelled'));
            } else if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          settleOpen();
          reject(error);
        }
      }),
      stopReply.then(() => new Promise<void>(() => {})),
    ]);
    if (closed) throw failure ?? new Error('error.operationCancelled');
    options.onDiagnostic?.(`UART GDB Stub: ${options.port}, ${options.baudRate} baud, ${options.stubMode}.`);
    // Panic stubs may have printed their initial stop before the host opened the port.
    // '?' only asks for the current stop reason; it does not interrupt or reset the CPU.
    const request = options.stubMode === 'runtime' ? Buffer.from([3]) : Buffer.from('$?#3f');
    if (!ready) {
      if (options.stubMode === 'runtime') {
        // An already-paused IDF stub ignores Ctrl+C; ask for its existing stop once.
        stopQueryTimer = setTimeout(() => {
          stopQueryTimer = undefined;
          if (closed || ready) return;
          try {
            serial.write(Buffer.from('$?#3f'), (error) => {
              if (error) fail(error);
            });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        }, 150);
      }
      serial.write(request, (error) => {
        if (error) fail(error);
      });
    }
    await stopReply;
    if (closed) throw failure ?? new Error('error.operationCancelled');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    if (closed) {
      server.close();
      throw failure ?? new Error('error.operationCancelled');
    }
    returned = true;
    return { port: (server.address() as net.AddressInfo).port, close };
  } catch (error) {
    await close();
    throw failure ?? error;
  }
}
