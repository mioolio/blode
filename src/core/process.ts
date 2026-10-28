import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  output: string;
}
export interface RunOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

/** A process boundary: arguments never pass through a shell; output is bounded. */
export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error('error.operationCancelled');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, NO_COLOR: '1', LC_ALL: 'C' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let pending = '';
    let settled = false;
    const stop = () => {
      // Compilers launch subprocesses; Windows needs the whole owned process tree stopped.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {
          child.kill();
        });
      } else child.kill();
    };
    const abort = () => {
      stop();
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error('error.operationCancelled'));
      }
    };
    const timer = setTimeout(() => {
      stop();
      options.signal?.removeEventListener('abort', abort);
      if (!settled) {
        settled = true;
        reject(new Error('error.processTimeout'));
      }
    }, options.timeout ?? 120_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    const consume = (data: Buffer) => {
      const chunk = data.toString('utf8');
      output = (output + chunk).slice(-2_000_000);
      pending = (pending + chunk).slice(-64_000);
      const lines = pending.split(/\r?\n|\r/g);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) options.onLine?.(line);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (pending.trim()) options.onLine?.(pending);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? -1, output });
      }
    });
  });
}

export async function commandExists(
  command: string,
  args = ['--version'],
  options: Pick<RunOptions, 'signal' | 'env'> = {},
): Promise<string | null> {
  try {
    const result = await runCommand(command, args, { timeout: 12_000, ...options });
    return result.code === 0 ? result.output.trim() : null;
  } catch {
    return null;
  }
}
