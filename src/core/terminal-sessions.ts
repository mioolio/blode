import { randomUUID } from 'node:crypto';
import { HostTerminal } from './terminal';
import type {
  TerminalCursor,
  TerminalOpenOptions,
  TerminalSessionInfo,
  TerminalState,
  TerminalTarget,
} from '../shared/terminal';

type Options = ConstructorParameters<typeof HostTerminal>[0];
interface Entry {
  terminal: HostTerminal;
  name: string;
}
const idOf = (value?: string) => {
  const id = value ?? 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(id)) throw new Error('rpc.invalidParams');
  return id;
};

/** Stable logical session names route input independently from each PTY generation. */
export class HostTerminals {
  private entries = new Map<string, Entry>();
  private counter = 0;
  private disposed = false;
  constructor(private readonly options: Options) {}
  private entry(id: string, name?: string): Entry {
    if (this.disposed) throw new Error('error.terminalClosed');
    if (name !== undefined && (!name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)))
      throw new Error('rpc.invalidParams');
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= 32) throw new Error('rpc.limitExceeded');
      const root = this.options.projectRoot();
      const ordinal = ++this.counter;
      entry = {
        name: name?.trim() ?? (id === 'default' || id.startsWith('term-') ? `Terminal ${ordinal}` : id),
        terminal: new HostTerminal({
          ...this.options,
          projectRoot: id === 'default' ? this.options.projectRoot : () => root,
          emit: (event) => this.options.emit({ ...event, terminalId: id }),
        }),
      };
      this.entries.set(id, entry);
    } else if (name !== undefined) entry.name = name.trim();
    return entry;
  }
  private selected(target: TerminalTarget, createDefault = false): [string, Entry] {
    const id = idOf(target.terminalId);
    const entry = this.entries.get(id) ?? (createDefault && id === 'default' ? this.entry(id) : undefined);
    if (!entry) throw new Error('error.terminalClosed');
    if (target.sessionId && target.sessionId !== entry.terminal.summary().sessionId)
      throw new Error('error.terminalSessionChanged');
    return [id, entry];
  }
  private decorate(id: string, entry: Entry, state: TerminalState): TerminalState {
    return { ...state, terminalId: id, name: entry.name };
  }
  sessions(): TerminalSessionInfo[] {
    return [...this.entries].map(([terminalId, entry]) => {
      const summary = entry.terminal.summary();
      return {
        terminalId,
        name: entry.name,
        sessionId: summary.sessionId,
        active: !!summary.active,
        running: summary.running,
        cwd: summary.cwd,
        shell: summary.shell,
        exitCode: summary.exitCode,
      };
    });
  }
  state(cursor: TerminalCursor = {}) {
    const id = idOf(cursor.terminalId);
    const entry = this.entries.get(id);
    if (!entry) {
      if (cursor.terminalId !== undefined) throw new Error('error.terminalClosed');
      return { ...new HostTerminal(this.options).state(cursor), terminalId: 'default', name: 'Terminal' };
    }
    return this.decorate(id, entry, entry.terminal.state(cursor));
  }
  async open(options: TerminalOpenOptions = {}) {
    if (options.create && options.terminalId !== undefined) throw new Error('rpc.invalidParams');
    const id = options.create ? `term-${randomUUID()}` : idOf(options.terminalId);
    const entry = this.entry(id, options.name);
    return this.decorate(id, entry, await entry.terminal.open(options));
  }
  async run(request: TerminalTarget & { command: string }) {
    if (
      typeof request.command !== 'string' ||
      !request.command.trim() ||
      request.command.length > 16384 ||
      request.command.includes('\0')
    )
      throw new Error('rpc.invalidParams');
    if (request.sessionId && !this.selected(request)[1].terminal.summary().active)
      throw new Error('error.terminalClosed');
    const id = idOf(request.terminalId);
    const entry = this.entry(id);
    await entry.terminal.open();
    this.selected(request);
    return this.decorate(id, entry, await entry.terminal.run(request.command));
  }
  write(request: TerminalTarget & { data: string }) {
    this.selected(request)[1].terminal.write(request);
  }
  resize(request: TerminalTarget & { cols: number; rows: number }) {
    this.selected(request)[1].terminal.resize(request);
  }
  stop(target: TerminalTarget = {}) {
    if (!this.entries.has(idOf(target.terminalId)) && !target.terminalId && !target.sessionId) return;
    this.selected(target)[1].terminal.stop();
  }
  async close(target: TerminalTarget = {}) {
    if (!this.entries.has(idOf(target.terminalId)) && !target.terminalId && !target.sessionId) return;
    const [id, entry] = this.selected(target);
    this.entries.delete(id);
    await entry.terminal.close();
  }
  async closeAll() {
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.terminal.close()));
  }
}
