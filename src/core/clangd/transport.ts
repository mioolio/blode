import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_MESSAGE = 32 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ClangdTransportOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** Framed JSON-RPC over clangd's stdio, bounded and restartable by the caller. */
export class ClangdTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<(method: string, params: unknown) => void>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private stderrText = '';
  private serverHandler?: (method: string, params: unknown) => unknown | Promise<unknown>;

  constructor(private readonly options: ClangdTransportOptions) {
    this.child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderrText.length < MAX_STDERR)
        this.stderrText = (this.stderrText + chunk.toString('utf8')).slice(-MAX_STDERR);
      for (const line of chunk.toString('utf8').split(/\r?\n/))
        if (line.trim()) options.onStderr?.(line.trim());
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(new Error('error.clangdUnavailable'));
      options.onExit?.(code, signal);
    });
  }

  static start(options: ClangdTransportOptions): ClangdTransport {
    return new ClangdTransport(options);
  }

  get lastError(): string {
    return this.stderrText.slice(-2048);
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Answer server-to-client requests such as `workspace/applyEdit`. */
  setServerRequestHandler(handler: (method: string, params: unknown) => unknown | Promise<unknown>): void {
    this.serverHandler = handler;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(payload: unknown): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error('error.clangdUnavailable');
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30_000) {
    if (this.closed) return Promise.reject(new Error('error.clangdUnavailable'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('error.clangdTimeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private read(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (this.buffer.length > 16 * 1024) this.fail(new Error('error.clangdProtocol'));
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE) {
        this.fail(new Error('error.clangdProtocol'));
        return;
      }
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body);
      } catch {
        this.fail(new Error('error.clangdProtocol'));
        return;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message.id !== undefined && typeof message.method === 'string') {
      this.answerServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = message.error as { message?: string; code?: number };
        pending.reject(new Error(error.message ?? 'error.clangdRequest'));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      for (const handler of this.handlers) handler(message.method, message.params);
    }
  }

  private answerServerRequest(message: Record<string, unknown>): void {
    const method = message.method as string;
    const respond = (result: unknown) => {
      try {
        this.write({ jsonrpc: '2.0', id: message.id, result });
      } catch {
        /* The process is going away; the caller handles the exit. */
      }
    };
    if (this.serverHandler) {
      void Promise.resolve()
        .then(() => this.serverHandler!(method, message.params))
        .then(respond, () => respond(null));
      return;
    }
    let result: unknown = null;
    if (method === 'workspace/configuration') result = [];
    else if (method === 'window/workDoneProgress/create') result = null;
    else if (method === 'client/registerCapability') result = null;
    respond(result);
  }

  dispose(): void {
    if (this.closed) return;
    try {
      this.notify('exit');
    } catch {
      /* Already closed. */
    }
    this.fail(new Error('error.clangdUnavailable'));
    this.child.kill();
  }
}
