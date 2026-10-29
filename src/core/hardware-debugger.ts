import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type {
  DebuggerState,
  DebuggerAction,
  DebuggerStorage,
  ProjectConfig,
  InstallationProgress,
} from '../shared/contracts';
import { parseMiValues, type MiValue } from './gdb-mi';
import { GnuArmToolchain } from '../../extensions/boards/stm32/gnu';
import { runCommand } from './process';

const object = (v: MiValue | undefined) => (v && !Array.isArray(v) && typeof v === 'object' ? v : {});
const list = (v: MiValue | undefined) => (Array.isArray(v) ? v : []);
const str = (v: MiValue | undefined) => (typeof v === 'string' ? v : '');

/** Owns an explicit SWD attach session; never executes GDB load or writes firmware. */
export class HardwareDebugger {
  private gdb: ChildProcessWithoutNullStreams | null = null;
  private server: ReturnType<typeof spawn> | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: Record<string, MiValue>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private snapshot: DebuggerState = {
    connection: 'disconnected',
    tools: { gdb: false, server: false },
    message: '',
    symbols: '',
    registers: [],
    stack: [],
    breakpoints: [],
    log: [],
  };
  private symbols = '';
  private gdbOverride = '';
  private refreshing = false;
  constructor(
    private readonly root: string,
    private readonly dataRoot: string,
    private readonly emit: (message: string) => void = () => {},
  ) {}
  get active() {
    return !!this.gdb || !!this.server || this.snapshot.connection === 'connecting';
  }
  private log(line: string) {
    this.snapshot.log = [...this.snapshot.log.slice(-299), line.slice(0, 8192)];
  }
  private async find(name: string, extra: string[] = []): Promise<string | null> {
    const executable = name + (process.platform === 'win32' ? '.exe' : '');
    const candidates = [
      ...extra,
      ...(process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((p) => path.isAbsolute(p))
        .map((p) => path.join(p, executable)),
    ];
    for (const file of candidates)
      if (
        await fs
          .stat(file)
          .then((s) => s.isFile())
          .catch(() => false)
      )
        return file;
    return null;
  }
  private async tools(config?: ProjectConfig) {
    const gdb = await this.find('arm-none-eabi-gdb', [
      ...(this.gdbOverride ? [this.gdbOverride] : []),
      path.join(this.root, 'armgcc', 'bin', 'arm-none-eabi-gdb.exe'),
      path.join(this.root, 'armgcc', 'bin', 'arm-none-eabi-gdb'),
    ]);
    const custom = config?.toolchain.stlinkDirectory;
    const server = await this.find('st-util', [
      ...(custom ? [path.join(custom, 'st-util.exe'), path.join(custom, 'bin', 'st-util.exe')] : []),
      path.join(this.root, 'stlink', 'bin', 'st-util.exe'),
      path.join(this.root, 'stlink', 'bin', 'st-util'),
    ]);
    return { gdb, server };
  }
  async state() {
    const tools = await this.tools();
    this.snapshot.tools = { gdb: !!tools.gdb, server: !!tools.server };
    return structuredClone(this.snapshot);
  }
  async selectGdb(file: string) {
    if (this.active) throw new Error('error.debuggerBusy');
    if (!/gdb(?:\.exe)?$/i.test(path.basename(file))) throw new Error('error.debuggerToolsMissing');
    this.gdbOverride = file;
    await fs.mkdir(this.dataRoot, { recursive: true });
    await fs.writeFile(path.join(this.dataRoot, 'gdb-path.json'), JSON.stringify({ path: file }));
  }
  async restore() {
    try {
      this.gdbOverride =
        JSON.parse(await fs.readFile(path.join(this.dataRoot, 'gdb-path.json'), 'utf8')).path ?? '';
    } catch {}
  }
  async symbolsFile(file: string) {
    if (this.active) throw new Error('error.debuggerBusy');
    const bytes = await fs.readFile(file);
    if (
      bytes.length < 52 ||
      bytes.length > 128 * 1024 * 1024 ||
      bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
      bytes.readUInt16LE(18) !== 40
    )
      throw new Error('error.stm32InvalidElf');
    await fs.mkdir(this.dataRoot, { recursive: true });
    this.symbols = path.join(this.dataRoot, 'symbols.elf');
    await fs.writeFile(this.symbols, bytes);
    this.snapshot.symbols = path.basename(file);
    return this.snapshot.symbols;
  }
  async storage(): Promise<DebuggerStorage | null> {
    if (!this.symbols) return null;
    const bytes = await fs.readFile(this.symbols);
    if (bytes.length < 52 || bytes[4] !== 1 || bytes[5] !== 1) throw new Error('error.stm32InvalidElf');
    const offset = bytes.readUInt32LE(28),
      stride = bytes.readUInt16LE(42),
      count = bytes.readUInt16LE(44);
    if (stride < 32 || count > 256 || offset + stride * count > bytes.length)
      throw new Error('error.stm32InvalidElf');
    const segments: DebuggerStorage['segments'] = [];
    for (let index = 0; index < count; index++) {
      const base = offset + stride * index;
      if (bytes.readUInt32LE(base) !== 1) continue;
      const address = bytes.readUInt32LE(base + 8),
        size = bytes.readUInt32LE(base + 20);
      if (address + size > 0x100000000) throw new Error('error.stm32InvalidElf');
      segments.push({
        address,
        size,
        kind:
          address >= 0x20000000 && address < 0x30000000
            ? 'ram'
            : address >= 0x08000000 && address < 0x10000000
              ? 'flash'
              : 'other',
      });
    }
    return {
      name: this.snapshot.symbols,
      size: bytes.length,
      segments,
      preview: bytes.subarray(0, 256).toString('hex'),
      source: 'elf',
    };
  }
  async install(
    onProgress?: (progress: InstallationProgress) => void,
    onLine?: (line: string) => void,
    network: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
  ) {
    if (this.active) throw new Error('error.debuggerBusy');
    await new GnuArmToolchain({
      root: path.join(this.root, 'armgcc'),
      runner: runCommand,
      onLine: (line) => {
        this.log(line);
        onLine?.(line);
      },
      onProgress,
      ...network,
    }).install();
    if (!(await this.tools()).gdb) throw new Error('error.debuggerGdbChoose');
  }
  private consume(line: string) {
    this.log(line);
    const record = /^(\d*)\^([\w-]+)(?:,(.*))?$/.exec(line);
    if (record) {
      const pending = this.pending.get(Number(record[1]));
      if (!pending) return;
      this.pending.delete(Number(record[1]));
      clearTimeout(pending.timer);
      let data: Record<string, MiValue> = {};
      try {
        data = parseMiValues(record[3] ?? '');
      } catch (e) {
        pending.reject(e as Error);
        return;
      }
      if (record[2] === 'error') pending.reject(new Error(str(data.msg) || 'error.debuggerCommand'));
      else pending.resolve(data);
    }
    if (line.startsWith('*running')) this.snapshot.connection = 'running';
    if (line.startsWith('*stopped')) {
      this.snapshot.connection = 'stopped';
      void this.refresh().catch((e) => {
        this.snapshot.message = String(e);
      });
    }
  }
  private command(command: string): Promise<Record<string, MiValue>> {
    if (!this.gdb) return Promise.reject(new Error('error.debuggerDisconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('error.debuggerTimeout'));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.gdb!.stdin.write(`${id}${command}\n`);
    });
  }
  async connect(config: ProjectConfig) {
    if (this.active) throw new Error('error.debuggerBusy');
    if (config.boardId !== 'stm32') throw new Error('error.debuggerPlatform');
    const serial = config.programmer?.serialNumber;
    if (!serial || !/^[a-fA-F0-9]{1,64}$/.test(serial)) throw new Error('error.selectDebugProbe');
    const tools = await this.tools(config);
    if (!tools.gdb || !tools.server) throw new Error('error.debuggerToolsMissing');
    this.snapshot.connection = 'connecting';
    this.snapshot.message = '';
    this.snapshot.registers = [];
    this.snapshot.stack = [];
    this.snapshot.breakpoints = [];
    try {
      const reservation = net.createServer();
      await new Promise<void>((r, j) => {
        reservation.once('error', j);
        reservation.listen(0, '127.0.0.1', r);
      });
      const port = (reservation.address() as net.AddressInfo).port;
      await new Promise<void>((r) => reservation.close(() => r()));
      this.server = spawn(
        tools.server,
        [
          '-m',
          '--no-reset',
          '--serial',
          serial,
          '-p',
          String(port),
          '-F',
          String(config.programmer?.frequencyKhz ?? 1800) + 'k',
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.server.stdout?.on('data', (b) => this.log(String(b)));
      this.server.stderr?.on('data', (b) => this.log(String(b)));
      this.server.once('error', (e) => {
        this.snapshot.message = e.message;
        void this.disconnect('error');
      });
      this.server.once('exit', () => {
        if (this.active && this.snapshot.connection !== 'disconnected') {
          this.snapshot.message = 'error.debuggerServerExited';
          void this.disconnect('error');
        }
      });
      await new Promise<void>((resolve, reject) => {
        let tries = 0;
        const attempt = () => {
          const socket = net.createConnection({ host: '127.0.0.1', port });
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', () => {
            socket.destroy();
            if (++tries >= 40) reject(new Error('error.debuggerServerStart'));
            else setTimeout(attempt, 150);
          });
        };
        attempt();
      });
      this.gdb = spawn(tools.gdb, ['--interpreter=mi2', '--nx', '--quiet'], {
        windowsHide: true,
        stdio: 'pipe',
      });
      let buffer = '';
      this.gdb.stdout.on('data', (b) => {
        buffer += String(b);
        if (buffer.length > 2_000_000) buffer = buffer.slice(-1_000_000);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) this.consume(line);
      });
      this.gdb.stderr.on('data', (b) => this.log(String(b)));
      this.gdb.once('error', (e) => {
        this.snapshot.message = e.message;
        void this.disconnect('error');
      });
      this.gdb.once('exit', () => {
        if (this.snapshot.connection !== 'disconnected') void this.disconnect('error');
      });
      await this.command('-gdb-set pagination off');
      await this.command('-gdb-set mi-async on');
      await this.command('-gdb-set auto-load safe-path /nonexistent');
      if (this.symbols)
        await this.command('-file-exec-and-symbols ' + JSON.stringify(this.symbols.replaceAll('\\', '/')));
      await this.command('-target-select extended-remote 127.0.0.1:' + port);
      this.snapshot.connection = 'stopped';
      await this.refresh();
    } catch (e) {
      this.snapshot.message = e instanceof Error ? e.message : String(e);
      await this.disconnect('error');
      throw e;
    }
  }
  private async refresh() {
    if (this.refreshing || !this.gdb || this.snapshot.connection !== 'stopped') return;
    this.refreshing = true;
    try {
      const names = list((await this.command('-data-list-register-names'))['register-names']).map(str);
      const values = list((await this.command('-data-list-register-values x'))['register-values']);
      this.snapshot.registers = values
        .map((v) => {
          const o = object(v);
          return { name: names[Number(str(o.number))] ?? str(o.number), value: str(o.value) };
        })
        .filter((v) => v.name);
      this.snapshot.programCounter = this.snapshot.registers.find(
        (item) => item.name === 'pc' || item.name === 'r15',
      )?.value;
      this.snapshot.updatedAt = new Date().toISOString();
      try {
        const code = await this.command('-data-disassemble -s "$pc" -e "$pc + 64" -- 0');
        this.snapshot.instructions = list(code.asm_insns).map((value) => {
          const item = object(value);
          return {
            address: str(item.address),
            function: str(item['func-name']),
            offset: str(item.offset),
            instruction: str(item.inst),
          };
        });
      } catch (error) {
        this.snapshot.instructions = [];
        this.log('Disassembly: ' + String(error));
      }
      const frames = list((await this.command('-stack-list-frames 0 24')).stack);
      this.snapshot.stack = frames.map((v) => {
        const o = object(object(v).frame ?? v);
        return {
          level: str(o.level),
          function: str(o.func),
          file: str(o.fullname) || str(o.file),
          line: str(o.line),
          address: str(o.addr),
        };
      });
    } finally {
      this.refreshing = false;
    }
  }
  async action(action: DebuggerAction) {
    if (action === 'disconnect') {
      await this.disconnect();
      return;
    }
    if (!this.gdb) throw new Error('error.debuggerDisconnected');
    if (action !== 'pause' && this.snapshot.connection !== 'stopped')
      throw new Error('error.debuggerNotStopped');
    const commands = {
      continue: '-exec-continue',
      pause: '-exec-interrupt --all',
      step: '-exec-step-instruction',
      next: '-exec-next-instruction',
      finish: '-exec-finish',
    };
    await this.command(commands[action]);
  }
  async breakpoint(location: string, removeId?: string) {
    if (this.snapshot.connection !== 'stopped') throw new Error('error.debuggerNotStopped');
    if (removeId) {
      if (!/^\d+$/.test(removeId)) throw new Error('error.invalidArguments');
      await this.command('-break-delete ' + removeId);
      this.snapshot.breakpoints = this.snapshot.breakpoints.filter((b) => b.id !== removeId);
      return;
    }
    if (!location || location.length > 1024 || /[\r\n\0]/.test(location) || location.startsWith('-'))
      throw new Error('error.invalidArguments');
    const data = object((await this.command('-break-insert ' + JSON.stringify(location))).bkpt);
    this.snapshot.breakpoints.push({ id: str(data.number), location });
  }
  async memory(address: number, length: number) {
    if (this.snapshot.connection !== 'stopped') throw new Error('error.debuggerNotStopped');
    if (
      !Number.isSafeInteger(address) ||
      address < 0 ||
      address > 0xffffffff ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > 4096 ||
      address + length > 0x100000000
    )
      throw new Error('error.invalidArguments');
    const data = await this.command(`-data-read-memory-bytes 0x${address.toString(16)} ${length}`);
    return list(data.memory)
      .map((v) => str(object(v).contents))
      .join('');
  }
  async disconnect(state: 'disconnected' | 'error' = 'disconnected') {
    const gdb = this.gdb,
      server = this.server;
    this.gdb = null;
    this.server = null;
    this.snapshot.connection = state;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('error.debuggerDisconnected'));
    }
    this.pending.clear();
    gdb?.stdin.end();
    for (const child of [gdb, server])
      if (child?.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => child.kill());
        } else child.kill();
      }
    this.emit('status.debuggerDisconnected');
  }
}
