import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { LogEvent } from '../shared/contracts';
import type { TerminalState } from '../shared/terminal';
import { StringDecoder } from 'node:string_decoder';

/** Explicit user command runner on the target host; the editor and Git GUI do not interpolate commands. */
export class HostTerminal {
  private child?: ChildProcess;
  private value: TerminalState = { running: false, command: '', cwd: '', lines: [], exitCode: null };
  constructor(private readonly options: { projectRoot: () => string; emit: (event: LogEvent) => void }) {}
  state() {
    return structuredClone(this.value);
  }
  private line(message: string, level: LogEvent['level'] = 'info') {
    this.value.lines = [...this.value.lines.slice(-499), message.slice(0, 8192)];
    this.options.emit({ kind: 'terminal', level, message, time: new Date().toISOString() });
  }
  run(command: string) {
    if (this.child) throw new Error('error.terminalBusy');
    if (typeof command !== 'string' || !command.trim() || command.length > 16384 || command.includes('\0'))
      throw new Error('rpc.invalidParams');
    const cwd = this.options.projectRoot() || os.homedir();
    this.value = { ...this.value, running: true, command, cwd, exitCode: null };
    const executable =
      process.platform === 'win32'
        ? path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          )
        : '/bin/sh';
    const args =
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        : ['-lc', command];
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.line(`> ${command}`);
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const pending = ['', ''];
    const consume = (index: number, chunk: Buffer) => {
      pending[index] = (pending[index] + decoders[index].write(chunk)).slice(-64000);
      const lines = pending[index].split(/\r?\n|\r/);
      pending[index] = lines.pop() ?? '';
      for (const line of lines) this.line(line);
    };
    child.stdout?.on('data', (chunk) => consume(0, chunk));
    child.stderr?.on('data', (chunk) => consume(1, chunk));
    const timer = setTimeout(() => this.stop(), 120000);
    timer.unref();
    child.once('error', (error) => {
      this.line(error.message, 'error');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      for (let i = 0; i < 2; i++) {
        pending[i] += decoders[i].end();
        if (pending[i]) this.line(pending[i]);
      }
      if (this.child === child) this.child = undefined;
      this.value.running = false;
      this.value.exitCode = code ?? -1;
      this.line(`status.terminalExited ${code ?? -1}`, code === 0 ? 'success' : 'warning');
    });
    return this.state();
  }
  stop() {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.on('error', () => child.kill());
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  async close() {
    const child = this.child;
    if (!child) return;
    this.stop();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      timer.unref();
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
