import os from 'node:os';
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import type { LogEvent } from '../shared/contracts';
import type { TerminalCursor, TerminalState, TerminalChunk } from '../shared/terminal';
import { terminalShell } from './terminal-shell';
import { releasePty } from './pty-cleanup';
import { TerminalPrompt } from './terminal-prompt';
import { terminalLines } from './terminal-text';

const MAX_REPLAY = 1_000_000;
const validSize = (cols: number, rows: number) =>
  Number.isInteger(cols) && cols >= 20 && cols <= 500 && Number.isInteger(rows) && rows >= 5 && rows <= 300;

/** One host-owned interactive PTY survives renderer refreshes and directory/variable changes. */
export class HostTerminal {
  private pty?: IPty;
  private opening?: Promise<TerminalState>;
  private closing?: Promise<void>;
  private generation = 0;
  private value: TerminalState = {
    running: false,
    active: false,
    command: '',
    cwd: '',
    lines: [],
    exitCode: null,
    sequence: 0,
    cols: 100,
    rows: 24,
  };
  private chunks: TerminalChunk[] = [];
  private replayBytes = 0;
  private pending = '';
  private control = '';
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private ready?: () => void;
  private workspace = '';
  private prompt = new TerminalPrompt();
  private interruptBeforeBegin = false;
  constructor(
    private readonly options: {
      projectRoot: () => string;
      emit: (event: LogEvent) => void;
      shell?: typeof terminalShell;
    },
  ) {}
  state(cursor: TerminalCursor = {}) {
    const first = this.chunks[0]?.sequence ?? (this.value.sequence ?? 0) + 1;
    const reset =
      cursor.sessionId !== this.value.sessionId || cursor.after === undefined || cursor.after < first - 1;
    return structuredClone({
      ...this.value,
      reset,
      chunks: this.chunks.filter((chunk) => reset || chunk.sequence > (cursor.after ?? 0)),
    });
  }
  summary() {
    const { lines: _lines, ...summary } = this.value;
    return structuredClone(summary);
  }
  private changed() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.options.emit({ kind: 'terminal', level: 'info', message: '', time: new Date().toISOString() });
    }, 24);
    this.notifyTimer.unref();
  }
  private append(data: string) {
    if (!data) return;
    const sequence = (this.value.sequence ?? 0) + 1;
    this.value.sequence = sequence;
    this.chunks.push({ sequence, data });
    this.replayBytes += data.length;
    while ((this.replayBytes > MAX_REPLAY || this.chunks.length > 4096) && this.chunks.length > 1)
      this.replayBytes -= this.chunks.shift()!.data.length;
    // ANSI sequences may straddle native chunks; strip them only after joining a complete line.
    this.pending = (this.pending + data).slice(-64000);
    const lines = this.pending.split(/\r\n|\n/);
    this.pending = lines.pop() ?? '';
    for (const raw of lines)
      for (const line of terminalLines(raw)) {
        if (line.trim())
          this.value.lines = [...this.value.lines.slice(-499), line.replace(/\r/g, '').slice(0, 8192)];
      }
    this.finishPrompt(this.prompt.screen(data));
    this.changed();
  }
  private finishPrompt(completed?: { code: number }) {
    if (completed) {
      this.interruptBeforeBegin = false;
      this.value.running = false;
      this.value.exitCode = completed.code;
      this.ready?.();
    }
  }
  private consume(data: string) {
    if (this.ready && data.includes('\x1b[c')) {
      this.pty?.write('\x1b[?1;2c');
      data = data.replaceAll('\x1b[c', '');
    }
    this.control += data;
    const start = '\x1b]777;BL0DE;';
    while (this.control) {
      const index = this.control.indexOf(start);
      if (index < 0) {
        let keep = 0;
        for (let length = 1; length < start.length; length++)
          if (this.control.endsWith(start.slice(0, length))) keep = length;
        this.append(this.control.slice(0, this.control.length - keep));
        this.control = this.control.slice(this.control.length - keep);
        break;
      }
      if (index) {
        this.append(this.control.slice(0, index));
        this.control = this.control.slice(index);
      }
      const end = this.control.indexOf('\x07', start.length);
      if (end < 0) {
        if (this.control.length > 8192) {
          this.append(this.control);
          this.control = '';
        }
        break;
      }
      const fields = this.control.slice(start.length, end).split(';');
      this.control = this.control.slice(end + 1);
      if (
        fields[0] === this.value.sessionId &&
        fields[1] === 'B' &&
        /^\d+$/.test(fields[2] ?? '') &&
        this.prompt.begin(Number(fields[2]))
      ) {
        this.value.running = true;
        this.value.exitCode = null;
        this.value.command = Buffer.from(fields[3] ?? '', 'base64')
          .toString('utf8')
          .slice(0, 16384);
        if (this.interruptBeforeBegin) {
          this.interruptBeforeBegin = false;
          // A Ctrl+C delivered before PSReadLine accepts Enter can precede the
          // command itself. Deliver it again when that accepted command starts.
          try {
            this.pty?.write('\x03');
          } catch {
            /* onExit releases the closed PTY. */
          }
        }
        this.changed();
      }
      if (
        fields[0] === this.value.sessionId &&
        fields[1] === 'P' &&
        fields.length === 6 &&
        /^\d+$/.test(fields[2]) &&
        /^-?\d+$/.test(fields[3])
      ) {
        const cwd = Buffer.from(fields[4], 'base64').toString('utf8');
        if (cwd && cwd.length < 4096 && !cwd.includes('\0')) {
          this.value.cwd = cwd;
          this.finishPrompt(this.prompt.prompt(Number(fields[2]), Number(fields[3]), cwd, fields[5] === '1'));
          this.changed();
        }
      }
      if (
        (fields.length === 3 || fields.length === 4) &&
        fields[0] === this.value.sessionId &&
        /^-?\d+$/.test(fields[1])
      ) {
        if (fields.length === 3 || fields[3] === '1' || !this.value.running) {
          this.value.running = false;
          this.value.exitCode = Number(fields[1]);
        }
        const cwd = Buffer.from(fields[2], 'base64').toString('utf8');
        if (cwd && cwd.length < 4096 && !cwd.includes('\0')) this.value.cwd = cwd;
        this.ready?.();
        this.changed();
      }
    }
  }
  open(size: { cols?: number; rows?: number } = {}) {
    if (this.opening) return this.opening;
    this.opening = this.start(size, this.generation).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
  private async start(size: { cols?: number; rows?: number }, generation: number) {
    await this.closing;
    const workspace = this.options.projectRoot();
    if (this.pty && workspace === this.workspace) return this.state();
    if (this.pty) {
      if (this.value.running) throw new Error('error.terminalWorkspaceChanged');
      await this.stopSession();
    }
    if (generation !== this.generation) throw new Error('error.terminalClosed');
    const cols = size.cols ?? 100,
      rows = size.rows ?? 24;
    if (!validSize(cols, rows)) throw new Error('rpc.invalidParams');
    const sessionId = randomUUID().replaceAll('-', '');
    this.workspace = workspace;
    const cwd = workspace || os.homedir();
    const shell = (this.options.shell ?? terminalShell)(sessionId);
    this.chunks = [];
    this.replayBytes = 0;
    this.pending = '';
    this.control = '';
    this.prompt = new TerminalPrompt();
    this.interruptBeforeBegin = false;
    this.value = {
      running: false,
      active: true,
      command: '',
      cwd,
      lines: [],
      exitCode: null,
      sessionId,
      sequence: 0,
      shell: shell.executable,
      cols,
      rows,
    };
    let pty: IPty;
    try {
      pty = spawn(shell.executable, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          LANG: process.env.LANG || 'C.UTF-8',
        },
        useConpty: true,
      });
    } catch (error) {
      this.value.active = false;
      throw new Error('error.terminalUnavailable', { cause: error });
    }
    this.pty = pty;
    pty.onData((data) => {
      if (this.pty === pty) this.consume(data);
    });
    pty.onExit(({ exitCode }) => {
      if (this.pty !== pty) return;
      this.pty = undefined;
      this.value.active = false;
      this.value.running = false;
      this.value.exitCode = exitCode;
      this.ready?.();
      this.ready = undefined;
      this.changed();
      releasePty(pty);
    });
    const ready = new Promise<TerminalState>((resolve) => {
      const timer = setTimeout(() => {
        this.ready = undefined;
        resolve(this.state());
      }, 3000);
      timer.unref();
      this.ready = () => {
        clearTimeout(timer);
        this.ready = undefined;
        resolve(this.state());
      };
      if (shell.initialize) pty.write(shell.initialize + '\r');
    });
    this.changed();
    return ready;
  }
  private session(id?: string) {
    if (!this.pty) throw new Error('error.terminalClosed');
    if (id && id !== this.value.sessionId) throw new Error('error.terminalSessionChanged');
    return this.pty;
  }
  async run(command: string) {
    if (typeof command !== 'string' || !command.trim() || command.length > 16384 || command.includes('\0'))
      throw new Error('rpc.invalidParams');
    await this.open();
    if (this.value.running) throw new Error('error.terminalBusy');
    this.prompt.request();
    this.value.running = true;
    this.value.command = command;
    this.value.exitCode = null;
    const text = /[\r\n]/.test(command)
      ? process.platform === 'win32'
        ? `. {\n${command}\n}`
        : `{\n${command}\n}`
      : command;
    this.session().write(text.replace(/\r?\n/g, process.platform === 'win32' ? '\r' : '\n') + '\r');
    this.changed();
    return this.state();
  }
  write(request: { data: string; sessionId?: string }) {
    if (typeof request.data !== 'string' || request.data.length > 32768 || request.data.includes('\0'))
      throw new Error('rpc.invalidParams');
    const pty = this.session(request.sessionId);
    if (/[\r\n]/.test(request.data) && !this.value.running) {
      this.prompt.request();
      this.value.running = true;
      this.value.exitCode = null;
    }
    if (request.data.includes('\x03') && this.value.running && this.prompt.awaitingBegin())
      this.interruptBeforeBegin = true;
    pty.write(request.data);
  }
  resize(request: { cols: number; rows: number; sessionId?: string }) {
    if (!validSize(request.cols, request.rows)) throw new Error('rpc.invalidParams');
    const pty = this.session(request.sessionId);
    if (request.cols !== this.value.cols || request.rows !== this.value.rows) {
      pty.resize(request.cols, request.rows);
      this.value.cols = request.cols;
      this.value.rows = request.rows;
      this.changed();
    }
  }
  stop() {
    if (this.pty) {
      if (this.value.running && this.prompt.awaitingBegin()) this.interruptBeforeBegin = true;
      this.pty.write('\x03');
    }
  }
  close() {
    this.generation++;
    return this.stopSession();
  }
  private stopSession() {
    if (this.closing) return this.closing;
    this.closing = this.end().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
  private async end() {
    const pty = this.pty;
    if (!pty) return;
    await new Promise<void>((resolve) => {
      let forcing = false;
      const forceClose = () => {
        if (forcing) return;
        forcing = true;
        if (process.platform === 'win32') {
          const killer = spawnProcess('taskkill', ['/PID', String(pty.pid), '/T', '/F'], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore',
          });
          killer.on('error', () => releasePty(pty));
          killer.on('close', () => releasePty(pty));
        } else releasePty(pty);
      };
      const timer = setTimeout(forceClose, 1500);
      timer.unref();
      const deadline = setTimeout(() => {
        releasePty(pty);
        listener.dispose();
        resolve();
      }, 4000);
      deadline.unref();
      const listener = pty.onExit(() => {
        clearTimeout(timer);
        clearTimeout(deadline);
        listener.dispose();
        resolve();
      });
      try {
        pty.write('\x03');
        setTimeout(() => {
          if (this.pty !== pty) return;
          try {
            pty.write('exit\r');
          } catch {
            forceClose();
          }
        }, 50).unref();
      } catch {
        clearTimeout(timer);
        forceClose();
      }
    });
    if (this.pty === pty) {
      this.pty = undefined;
      this.value.active = false;
      this.value.running = false;
    }
    this.changed();
  }
}
