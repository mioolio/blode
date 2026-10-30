import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  DebuggerState,
  DebuggerAction,
  DebuggerStorage,
  ProjectConfig,
  InstallationProgress,
} from '../shared/contracts';
import { parseMiValues, type MiValue } from './gdb-mi';
import { GnuArmToolchain } from '../../extensions/boards/STM32F103C8T6/tools/gnu';
import { runCommand } from './process';
import { assembleThumbInstruction, assemblerToolsFromGdb } from './debugger-assembler';
import { debuggerProfiles, getDebuggerProfile, type DebuggerProfile } from '../shared/debugger-profiles';
import { debuggerServerArguments, debuggerSegmentKind } from './debugger-target';
import { discoverEsp32DebugTools, installEsp32DebugTools } from './esp32-debug-tools';
import { preflightEsp32UsbJtag } from '../../extensions/boards/Esp32_S3_CAM/device/debug-usb';
import {
  openUartGdbBridge,
  validateUartGdbOptions,
  type UartGdbBridge,
} from '../../extensions/boards/Esp32_S3_CAM/debugger/uart-gdb';
import { esp32UartGdbEnvironment } from '../../extensions/boards/Esp32_S3_CAM/debugger/uart-gdb-config';
import type { AutomaticDebugSymbolResolver } from './build-debug-symbols';
import {
  breakpointLocationsSchema,
  debuggerPatchSchema,
  debuggerAssembleSchema,
  type DebuggerPatchRequest,
  type DebuggerPatchResult,
  type DebuggerBreakpointResult,
} from '../shared/debugger-edit';

const object = (v: MiValue | undefined) => (v && !Array.isArray(v) && typeof v === 'object' ? v : {});
const list = (v: MiValue | undefined) => (Array.isArray(v) ? v : []);
const str = (v: MiValue | undefined) => (typeof v === 'string' ? v : '');

/** Owns an explicit SWD attach session. Code edits use verified SRAM writes, never GDB load. */
export class HardwareDebugger {
  private spawnProcess: typeof spawn = spawn;
  private usbPreflightAbort?: AbortController;
  private openUartBridge = openUartGdbBridge;
  private uartGdbEnvironment = esp32UartGdbEnvironment;
  private uartBridge?: UartGdbBridge;
  private uartPort?: string;
  private disconnecting?: Promise<void>;
  private gdb: ChildProcessWithoutNullStreams | null = null;
  private server: ReturnType<typeof spawn> | null = null;
  private sequence = 0;
  private executionTokens = new Set<number>();
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
  private profile: DebuggerProfile = debuggerProfiles.STM32F103C8T6;
  private debugConfig: ProjectConfig | undefined;
  private readonly gdbOverrides = new Map<string, string>();
  private readonly symbolFiles = new Map<string, { file: string; name: string; automaticId?: string }>();
  private symbolRevision = 0;
  private refreshTask: Promise<void> | undefined;
  private editing = false;
  private editSettled?: Promise<void>;
  private session = 0;
  private stopRevision = 0;
  private keepPaused = false;
  private permitPauseRequest = false;
  private stopWaiters = new Set<{
    resolve: (data: Record<string, MiValue>) => void;
    reject: (error: Error) => void;
  }>();
  constructor(
    private readonly root: string,
    private readonly dataRoot: string,
    private readonly emit: (message: string) => void = () => {},
    private readonly automaticSymbols?: AutomaticDebugSymbolResolver,
  ) {}
  get active() {
    return (
      !!this.gdb ||
      !!this.server ||
      !!this.uartPort ||
      !!this.disconnecting ||
      this.snapshot.connection === 'connecting'
    );
  }
  get ownedSerialPort(): string | undefined {
    return this.uartPort;
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
  private async tools(config?: ProjectConfig, profile = this.profile) {
    if (profile.architecture === 'xtensa') {
      const found = await discoverEsp32DebugTools({
        root: this.root,
        dataRoot: this.dataRoot,
        config,
        gdbPath: this.gdbOverrides.get(profile.id),
      });
      return { gdb: found.gdb, server: found.openocd, scripts: found.scripts };
    }
    const configuredFile = async (file: string) =>
      path.isAbsolute(file) && (await fs.stat(file).catch(() => null))?.isFile() ? file : null;
    const gdb = config?.debugger?.gdbPath
      ? await configuredFile(config.debugger.gdbPath)
      : await this.find('arm-none-eabi-gdb', [
          ...(config?.debugger?.gdbPath ? [config.debugger.gdbPath] : []),
          ...(this.gdbOverrides.get(profile.id) || this.gdbOverride
            ? [this.gdbOverrides.get(profile.id) || this.gdbOverride]
            : []),
          path.join(this.root, 'armgcc', 'bin', 'arm-none-eabi-gdb.exe'),
          path.join(this.root, 'armgcc', 'bin', 'arm-none-eabi-gdb'),
        ]);
    const custom = config?.toolchain.stlinkDirectory;
    const server = config?.debugger?.serverPath
      ? await configuredFile(config.debugger.serverPath)
      : await this.find('st-util', [
          ...(config?.debugger?.serverPath ? [config.debugger.serverPath] : []),
          ...(custom ? [path.join(custom, 'st-util.exe'), path.join(custom, 'bin', 'st-util.exe')] : []),
          path.join(this.root, 'stlink', 'bin', 'st-util.exe'),
          path.join(this.root, 'stlink', 'bin', 'st-util'),
        ]);
    return { gdb, server, scripts: null };
  }
  private async probeUsbJtag(
    config: ProjectConfig,
    profile: DebuggerProfile,
    signal: AbortSignal,
    session: number,
  ) {
    if (profile.transport !== 'usb-jtag') return;
    await preflightEsp32UsbJtag({
      runner: runCommand,
      signal,
      serialNumber: config.debugger?.serialNumber,
      onDiagnostic: (message) => {
        if (session === this.session) this.log(message);
      },
    });
  }
  private configure(config?: ProjectConfig) {
    if (!config || this.active) return;
    if (this.debugConfig && JSON.stringify(this.debugConfig) === JSON.stringify(config)) return;
    const profile = getDebuggerProfile(config.boardId, config.debugger);
    if (!profile) return;
    const targetIdentity = (value: ProjectConfig, target: DebuggerProfile) => {
      const port = value.debugger?.port?.trim() ?? '';
      return JSON.stringify([
        value.boardId,
        target.transport,
        target.transport === 'uart-gdb'
          ? /^COM\d+$/i.test(port)
            ? port.toUpperCase()
            : port
          : target.transport === 'usb-jtag'
            ? (value.debugger?.serialNumber ?? '').replace(/[:-]/g, '').toUpperCase()
            : (value.programmer?.serialNumber ?? '').toUpperCase(),
        target.transport === 'uart-gdb' ? (value.debugger?.stubMode ?? 'runtime') : '',
        value.runtime?.deviceId ?? '',
      ]);
    };
    if (
      this.debugConfig &&
      targetIdentity(this.debugConfig, this.profile) !== targetIdentity(config, profile)
    ) {
      this.snapshot.connection = 'disconnected';
      this.snapshot.message = '';
    }
    this.debugConfig = structuredClone(config);
    this.profile = profile;
    const symbols = this.symbolFiles.get(profile.id);
    this.symbols = symbols?.file ?? '';
    this.snapshot.symbols = symbols?.name ?? '';
  }
  async state(config?: ProjectConfig): Promise<DebuggerState> {
    this.configure(config);
    const profile = this.profile,
      session = this.session,
      selection = this.debugConfig;
    const tools = await this.tools(selection, profile);
    if (profile !== this.profile || session !== this.session || selection !== this.debugConfig)
      return this.state();
    this.snapshot.tools = {
      gdb: !!tools.gdb,
      server:
        profile.transport === 'uart-gdb' ||
        (!!tools.server && (profile.transport !== 'usb-jtag' || !!tools.scripts)),
      paths: {
        gdb: tools.gdb,
        server: profile.transport === 'uart-gdb' ? null : tools.server,
        scripts: profile.transport === 'uart-gdb' ? null : tools.scripts,
      },
    };
    this.snapshot.profile = this.profile;
    return structuredClone(this.snapshot);
  }
  async selectGdb(file: string, expectedProfileId?: string) {
    if (this.active) throw new Error('error.debuggerBusy');
    if (expectedProfileId && expectedProfileId !== this.profile.id)
      throw new Error('error.debuggerSessionChanged');
    if (!/gdb(?:-no-python)?(?:\.exe)?$/i.test(path.basename(file)))
      throw new Error('error.debuggerToolsMissing');
    this.gdbOverrides.set(this.profile.id, file);
    await fs.mkdir(this.dataRoot, { recursive: true });
    await fs.writeFile(
      path.join(this.dataRoot, 'debugger-tools.json'),
      JSON.stringify(Object.fromEntries(this.gdbOverrides)),
    );
  }
  async restore() {
    try {
      const paths: unknown = JSON.parse(
        await fs.readFile(path.join(this.dataRoot, 'debugger-tools.json'), 'utf8'),
      );
      if (paths && typeof paths === 'object')
        for (const [id, file] of Object.entries(paths))
          if (getDebuggerProfile(id) && typeof file === 'string') this.gdbOverrides.set(id, file);
    } catch {}
    try {
      this.gdbOverride =
        JSON.parse(await fs.readFile(path.join(this.dataRoot, 'gdb-path.json'), 'utf8')).path ?? '';
    } catch {}
  }
  async symbolsFile(file: string) {
    if (this.active) throw new Error('error.debuggerBusy');
    const revision = ++this.symbolRevision,
      profile = this.profile;
    const bytes = await fs.readFile(file);
    if (revision !== this.symbolRevision || this.profile !== profile)
      throw new Error('error.debuggerSessionChanged');
    return this.symbolsBytes(bytes, path.basename(file));
  }
  async symbolsBytes(bytes: Buffer, name: string) {
    return this.storeSymbols(bytes, name);
  }
  private canUpdateSymbols(session?: number) {
    return session === undefined
      ? !this.active
      : session === this.session &&
          this.snapshot.connection === 'connecting' &&
          !this.gdb &&
          !this.server &&
          !this.uartPort &&
          !this.disconnecting;
  }
  private async refreshAutomaticSymbols(session?: number) {
    if (!this.automaticSymbols || !this.debugConfig || !this.canUpdateSymbols(session)) return;
    const profile = this.profile,
      selection = this.debugConfig,
      revision = this.symbolRevision;
    const current = this.symbolFiles.get(profile.id);
    if (current && current.automaticId === undefined) return;
    const automatic = await this.automaticSymbols(selection);
    if (
      this.profile !== profile ||
      this.debugConfig !== selection ||
      revision !== this.symbolRevision ||
      !this.canUpdateSymbols(session)
    )
      return;
    if (!automatic) {
      if (current?.automaticId !== undefined) {
        this.symbolRevision++;
        this.symbolFiles.delete(profile.id);
        this.symbols = '';
        this.snapshot.symbols = '';
        await fs.unlink(current.file).catch(() => {});
      }
      return;
    }
    if (automatic.id !== current?.automaticId)
      await this.storeSymbols(automatic.bytes, automatic.name, automatic.id, session);
  }
  private async storeSymbols(bytes: Buffer, name: string, automaticId?: string, session?: number) {
    if (!this.canUpdateSymbols(session)) throw new Error('error.debuggerBusy');
    const revision = ++this.symbolRevision;
    const profile = this.profile;
    if (
      bytes.length < 52 ||
      bytes.length > 128 * 1024 * 1024 ||
      bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
      bytes[4] !== 1 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== profile.elfMachine
    )
      throw new Error('error.debuggerElfArchitecture');
    await fs.mkdir(this.dataRoot, { recursive: true });
    const file = path.join(this.dataRoot, `${profile.id}-${randomUUID()}.elf`);
    await fs.writeFile(file, bytes);
    if (!this.canUpdateSymbols(session) || this.profile !== profile || revision !== this.symbolRevision) {
      await fs.unlink(file).catch(() => {});
      throw new Error('error.debuggerSessionChanged');
    }
    const previous = this.symbolFiles.get(profile.id)?.file;
    this.symbols = file;
    this.snapshot.symbols = path.basename(name).slice(0, 255);
    this.symbolFiles.set(profile.id, { file: this.symbols, name: this.snapshot.symbols, automaticId });
    if (previous && previous !== file) await fs.unlink(previous).catch(() => {});
    return this.snapshot.symbols;
  }
  async storage(): Promise<DebuggerStorage | null> {
    await this.refreshAutomaticSymbols();
    if (!this.symbols) return null;
    const profile = this.profile,
      name = this.snapshot.symbols;
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
        kind: debuggerSegmentKind(profile, address, size),
      });
    }
    return {
      name,
      size: bytes.length,
      segments,
      preview: bytes.subarray(0, 256).toString('hex'),
      source: 'elf',
    };
  }
  async install(
    onProgress?: (progress: InstallationProgress) => void,
    onLine?: (line: string) => void,
    network: { fetcher?: typeof fetch; signal?: AbortSignal; config?: ProjectConfig } = {},
  ) {
    if (this.active) throw new Error('error.debuggerBusy');
    this.configure(network.config);
    const profile = this.profile;
    const config = this.debugConfig ? structuredClone(this.debugConfig) : undefined;
    if (profile.architecture === 'xtensa') {
      await installEsp32DebugTools({
        root: this.root,
        dataRoot: this.dataRoot,
        onProgress,
        onLine,
        fetcher: network.fetcher,
        signal: network.signal,
        ...(profile.transport === 'uart-gdb' ? { tools: ['gdb' as const] } : {}),
      });
      return;
    }
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
    if (!(await this.tools(config, profile)).gdb) throw new Error('error.debuggerGdbChoose');
  }
  private consume(line: string) {
    this.log(line);
    const record = /^(\d*)\^([\w-]+)(?:,(.*))?$/.exec(line);
    if (record) {
      const token = Number(record[1]);
      const pending = this.pending.get(token);
      if (!pending) {
        // GDB can report ^running and then a late ^error for the same resume token.
        if (record[2] === 'error' && this.executionTokens.delete(token)) {
          let message = 'error.debuggerCommand';
          try {
            message = str(parseMiValues(record[3] ?? '').msg) || message;
          } catch {}
          this.snapshot.message = message;
          void this.disconnect('error').catch((error) => this.log(String(error)));
        }
        return;
      }
      this.pending.delete(token);
      clearTimeout(pending.timer);
      let data: Record<string, MiValue> = {};
      try {
        data = parseMiValues(record[3] ?? '');
      } catch (e) {
        pending.reject(e as Error);
        return;
      }
      if (record[2] === 'error') pending.reject(new Error(str(data.msg) || 'error.debuggerCommand'));
      else {
        if (record[2] === 'running') {
          this.snapshot.connection = 'running';
          this.executionTokens.add(token);
          if (this.executionTokens.size > 32)
            this.executionTokens.delete(this.executionTokens.values().next().value!);
        }
        pending.resolve(data);
      }
    }
    const event = /^\d*\*(running|stopped)(?:,(.*))?$/.exec(line);
    if (event?.[1] === 'running') this.snapshot.connection = 'running';
    if (event?.[1] === 'stopped') {
      this.executionTokens.clear();
      this.snapshot.connection = 'stopped';
      this.stopRevision++;
      let data: Record<string, MiValue> = {};
      try {
        data = parseMiValues(event[2] ?? '');
      } catch {}
      for (const waiter of this.stopWaiters) waiter.resolve(data);
      this.stopWaiters.clear();
      const session = this.session;
      if (!this.editing && !this.disconnecting)
        void this.refresh().catch((e) => {
          if (session === this.session) this.snapshot.message = String(e);
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
      try {
        this.gdb!.stdin.write(`${id}${command}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async connect(config: ProjectConfig) {
    if (this.active || this.editing) throw new Error('error.debuggerBusy');
    if (!getDebuggerProfile(config.boardId)) throw new Error('error.debuggerPlatform');
    this.configure(config);
    const profile = this.profile;
    if (profile.transport === 'swd') {
      const serial = config.programmer?.serialNumber;
      if (!serial || !/^[a-fA-F0-9]{1,64}$/.test(serial)) throw new Error('error.selectDebugProbe');
    }
    const uartOptions = {
      port: config.debugger?.port ?? '',
      baudRate: config.debugger?.baudRate ?? 115200,
      stubMode: config.debugger?.stubMode ?? 'runtime',
    };
    if (profile.transport === 'uart-gdb') validateUartGdbOptions(uartOptions);
    this.snapshot.connection = 'connecting';
    this.snapshot.sessionId = randomUUID();
    const session = ++this.session;
    let processFailure: Error | undefined;
    const assertSession = () => {
      if (processFailure) throw processFailure;
      if (session !== this.session) throw new Error('error.operationCancelled');
    };
    const processFailed = (error: Error) => {
      if (session !== this.session || this.disconnecting) return;
      processFailure ??= error;
      this.snapshot.message = processFailure.message;
      void this.disconnect('error').catch((failure) => this.log(String(failure)));
    };
    this.snapshot.message = '';
    this.snapshot.registers = [];
    this.snapshot.stack = [];
    this.snapshot.breakpoints = [];
    try {
      await this.refreshAutomaticSymbols(session);
      assertSession();
      const tools = await this.tools(config);
      assertSession();
      if (!tools.gdb || (profile.transport !== 'uart-gdb' && !tools.server))
        throw new Error('error.debuggerToolsMissing');
      if (profile.transport === 'usb-jtag' && !tools.scripts) throw new Error('error.debuggerEspScripts');
      const gdbEnvironment =
        profile.transport === 'uart-gdb' ? await this.uartGdbEnvironment(tools.gdb) : undefined;
      assertSession();
      const preflight = new AbortController();
      this.usbPreflightAbort = preflight;
      const command = (text: string) => {
        assertSession();
        return this.command(text);
      };
      let port: number;
      if (profile.transport === 'uart-gdb') {
        this.uartPort = uartOptions.port;
        try {
          const bridge = await this.openUartBridge({
            ...uartOptions,
            signal: preflight.signal,
            onDiagnostic: (message) => {
              if (session === this.session) this.log(message);
            },
            onError: processFailed,
          });
          if (session !== this.session) {
            await bridge.close();
            throw new Error('error.operationCancelled');
          }
          this.uartBridge = bridge;
          port = bridge.port;
        } catch (error) {
          this.uartPort = undefined;
          throw error;
        } finally {
          if (this.usbPreflightAbort === preflight) this.usbPreflightAbort = undefined;
        }
      } else {
        try {
          await this.probeUsbJtag(config, profile, preflight.signal, session);
        } finally {
          if (this.usbPreflightAbort === preflight) this.usbPreflightAbort = undefined;
        }
        assertSession();
        const reservation = net.createServer();
        await new Promise<void>((r, j) => {
          reservation.once('error', j);
          reservation.listen(0, '127.0.0.1', r);
        });
        port = (reservation.address() as net.AddressInfo).port;
        await new Promise<void>((r) => reservation.close(() => r()));
        assertSession();
        this.server = this.spawnProcess(
          tools.server!,
          debuggerServerArguments(profile, config, port, tools.scripts),
          {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let serverOutput = '';
        const serverLine = (bytes: Buffer) => {
          if (session !== this.session) return;
          serverOutput = (serverOutput + String(bytes)).slice(-8192);
          this.log(String(bytes));
        };
        this.server.stdout?.on('data', serverLine);
        this.server.stderr?.on('data', serverLine);
        this.server.once('error', processFailed);
        // close follows drained stdout/stderr, so the final USB/driver diagnostic is available.
        this.server.once('close', (code, signal) =>
          processFailed(
            new Error(
              serverOutput.trim()
                ? `${profile.serverName}: ${serverOutput.trim()}`
                : `${profile.serverName} exited (${signal ?? code ?? 'unknown'}).`,
            ),
          ),
        );
        await new Promise<void>((resolve, reject) => {
          let tries = 0;
          const attempt = () => {
            try {
              assertSession();
            } catch (error) {
              reject(error);
              return;
            }
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.once('connect', () => {
              socket.destroy();
              resolve();
            });
            socket.once('error', () => {
              socket.destroy();
              if (++tries >= 40) reject(new Error(serverOutput.trim() || 'error.debuggerServerStart'));
              else setTimeout(attempt, 150);
            });
          };
          attempt();
        });
      }
      assertSession();
      this.gdb = this.spawnProcess(tools.gdb, ['--interpreter=mi2', '--nx', '--quiet'], {
        windowsHide: true,
        stdio: 'pipe',
        ...(gdbEnvironment ? { env: gdbEnvironment } : {}),
      });
      let buffer = '';
      this.gdb.stdout.on('data', (b) => {
        if (this.session !== session) return;
        buffer += String(b);
        if (buffer.length > 2_000_000) buffer = buffer.slice(-1_000_000);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) this.consume(line);
      });
      let gdbError = '';
      this.gdb.stderr.on('data', (b) => {
        if (session !== this.session) return;
        gdbError = (gdbError + String(b)).slice(-8192);
        this.log(String(b));
      });
      this.gdb.stdin.on('error', processFailed);
      this.gdb.once('error', processFailed);
      this.gdb.once('close', (code, signal) =>
        processFailed(
          new Error(
            gdbError.trim()
              ? `${profile.gdbName}: ${gdbError.trim()}`
              : `${profile.gdbName} exited (${signal ?? code ?? 'unknown'}).`,
          ),
        ),
      );
      await command('-gdb-set pagination off');
      assertSession();
      await command('-gdb-set mi-async on');
      await command('-gdb-set auto-load safe-path /nonexistent');
      if (profile.architecture === 'xtensa') {
        await command('-gdb-set remote hardware-breakpoint-limit 2');
        await command('-gdb-set remote hardware-watchpoint-limit 2');
      }
      if (profile.transport === 'uart-gdb') {
        // IDF's UART stub maps Z0 to CPU breakpoint slots. Never let GDB fall back to M/X instruction writes.
        await command('-gdb-set remote software-breakpoint-packet on');
        // IDF 5.1 advertises QThreadEvents but has no handler; querying it prevents execution commands.
        await command('-gdb-set remote thread-events-packet off');
      }
      if (this.symbols)
        await command('-file-exec-and-symbols ' + JSON.stringify(this.symbols.replaceAll('\\', '/')));
      await command(
        `-target-select ${profile.transport === 'uart-gdb' ? 'remote' : 'extended-remote'} 127.0.0.1:` + port,
      );
      assertSession();
      this.snapshot.connection = 'stopped';
      // GDB may emit additional stop notifications after ^connected (including one per core).
      // Restart a stale sample within this session; it is not a disconnect/reconnect conflict.
      for (let attempt = 0; ; attempt++) {
        try {
          await this.refresh();
          break;
        } catch (error) {
          assertSession();
          if (
            attempt >= 3 ||
            this.snapshot.connection !== 'stopped' ||
            !(error instanceof Error) ||
            error.message !== 'error.debuggerSessionChanged'
          )
            throw error;
        }
      }
      assertSession();
      this.snapshot.message = '';
    } catch (e) {
      const error = processFailure ?? (session !== this.session ? new Error('error.operationCancelled') : e);
      if (session === this.session) {
        this.snapshot.message = error instanceof Error ? error.message : String(error);
        await this.disconnect('error');
      }
      throw error;
    }
  }
  private refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    if (!this.gdb || this.snapshot.connection !== 'stopped') return Promise.resolve();
    const session = this.session,
      revision = this.stopRevision;
    const assertCurrent = () => {
      if (
        session !== this.session ||
        revision !== this.stopRevision ||
        !this.gdb ||
        this.snapshot.connection !== 'stopped'
      )
        throw new Error('error.debuggerSessionChanged');
    };
    const task = (async () => {
      const names = list((await this.command('-data-list-register-names'))['register-names']).map(str);
      assertCurrent();
      const supported = new Set([...this.profile.registerNames, this.profile.statusRegister]);
      const indices =
        this.profile.transport === 'uart-gdb'
          ? names.flatMap((name, index) => (supported.has(name) ? [index] : []))
          : [];
      if (this.profile.transport === 'uart-gdb' && !indices.length) throw new Error('error.debuggerCommand');
      const values = list(
        (
          await this.command('-data-list-register-values x' + (indices.length ? ' ' + indices.join(' ') : ''))
        )['register-values'],
      );
      assertCurrent();
      let registers = values
        .map((v) => {
          const o = object(v);
          return { name: names[Number(str(o.number))] ?? str(o.number), value: str(o.value) };
        })
        .filter((v) => v.name);
      if (this.profile.transport === 'uart-gdb') {
        // IDF 5.1's compact stub packet differs from newer GDB FP/TIE layouts.
        // Publish only the module's verified core register set.
        registers = registers.filter((register) => supported.has(register.name));
      }
      const programCounter = registers.find((item) => item.name === 'pc' || item.name === 'r15')?.value;
      let instructions: NonNullable<DebuggerState['instructions']> = [];
      try {
        const code = await this.command('-data-disassemble -s "$pc" -e "$pc + 64" -- 2');
        assertCurrent();
        instructions = list(code.asm_insns).map((value) => {
          const item = object(value);
          return {
            address: str(item.address),
            function: str(item['func-name']),
            offset: str(item.offset),
            instruction: str(item.inst),
            opcodes: str(item.opcodes),
          };
        });
      } catch (error) {
        assertCurrent();
        this.log('Disassembly: ' + String(error));
      }
      const frames = list((await this.command('-stack-list-frames 0 24')).stack);
      assertCurrent();
      const stack = frames.map((v) => {
        const o = object(object(v).frame ?? v);
        return {
          level: str(o.level),
          function: str(o.func),
          file: str(o.fullname) || str(o.file),
          line: str(o.line),
          address: str(o.addr),
        };
      });
      Object.assign(this.snapshot, {
        registers,
        programCounter,
        instructions,
        stack,
        updatedAt: new Date().toISOString(),
      });
    })();
    this.refreshTask = task;
    void task
      .finally(() => {
        if (this.refreshTask === task) this.refreshTask = undefined;
      })
      .catch(() => {});
    return task;
  }
  async action(action: DebuggerAction) {
    if (action === 'disconnect') {
      await this.disconnect();
      return;
    }
    if (!this.gdb) throw new Error('error.debuggerDisconnected');
    if (this.disconnecting) {
      if (action === 'pause' && this.permitPauseRequest) {
        this.keepPaused = true;
        return;
      }
      throw new Error('error.debuggerBusy');
    }
    const capability = action === 'continue' || action === 'pause' ? action : 'step';
    if (this.profile.capabilities?.[capability] === false) throw new Error('error.debuggerUartReadOnly');
    if (this.editing) {
      if (action === 'pause' && this.permitPauseRequest) {
        this.keepPaused = true;
        return;
      }
      throw new Error('error.debuggerBusy');
    }
    if (action !== 'pause' && this.snapshot.connection !== 'stopped')
      throw new Error('error.debuggerNotStopped');
    const commands = {
      continue: '-exec-continue',
      pause: '-exec-interrupt --all',
      step: '-exec-step-instruction',
      next: '-exec-next-instruction',
      finish: '-exec-finish',
    };
    await this.exclusive(async () => {
      if (!this.gdb) throw new Error('error.debuggerDisconnected');
      if (action !== 'pause' && this.snapshot.connection !== 'stopped')
        throw new Error('error.debuggerNotStopped');
      const revision = this.stopRevision;
      const session = this.session;
      await this.command(commands[action]);
      if (session !== this.session || !this.gdb)
        throw new Error(
          this.snapshot.connection === 'error' && this.snapshot.message
            ? this.snapshot.message
            : 'error.debuggerDisconnected',
        );
      // Some remote stubs send ^done rather than ^running for execution commands.
      if (action !== 'pause' && revision === this.stopRevision) this.snapshot.connection = 'running';
    });
    if (this.snapshot.connection === 'stopped' && !this.disconnecting) await this.refresh();
  }
  async breakpoint(location: string, removeId?: string) {
    return this.exclusive(async () => {
      await this.breakpointRaw(location, removeId);
    });
  }
  private async breakpointRaw(location: string, removeId?: string): Promise<string | undefined> {
    if (this.profile.capabilities?.breakpoints === false) throw new Error('error.debuggerUartReadOnly');
    if (this.snapshot.connection !== 'stopped') throw new Error('error.debuggerNotStopped');
    const session = this.session;
    if (removeId) {
      if (!/^\d+$/.test(removeId)) throw new Error('error.invalidArguments');
      await this.command('-break-delete ' + removeId);
      if (session !== this.session) throw new Error('error.debuggerSessionChanged');
      this.snapshot.breakpoints = this.snapshot.breakpoints.filter((b) => b.id !== removeId);
      return;
    }
    if (!location || location.length > 1024 || /[\r\n\0]/.test(location) || location.startsWith('-'))
      throw new Error('error.invalidArguments');
    const data = object(
      (
        await this.command(
          `-break-insert ${this.profile.architecture === 'xtensa' && this.profile.transport !== 'uart-gdb' ? '-h ' : ''}` +
            JSON.stringify(location),
        )
      ).bkpt,
    );
    if (session !== this.session) throw new Error('error.debuggerSessionChanged');
    const id = str(data.number);
    if (!/^\d+$/.test(id)) throw new Error('error.debuggerCommand');
    this.snapshot.breakpoints.push({ id, location });
    return id;
  }
  private async exclusive<T>(run: () => Promise<T>, permitPauseRequest = false): Promise<T> {
    if (this.editing || this.disconnecting) throw new Error('error.debuggerBusy');
    this.editing = true;
    let settled!: () => void;
    const editSettled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.editSettled = editSettled;
    this.keepPaused = false;
    this.permitPauseRequest = permitPauseRequest;
    const session = this.session;
    try {
      await this.refreshTask;
      if (session !== this.session) throw new Error('error.debuggerSessionChanged');
      return await run();
    } finally {
      this.editing = false;
      this.permitPauseRequest = false;
      if (this.editSettled === editSettled) this.editSettled = undefined;
      settled();
    }
  }
  async breakpoints(locations: string[]): Promise<DebuggerBreakpointResult[]> {
    const parsed = breakpointLocationsSchema.safeParse(locations);
    if (!parsed.success) throw new Error('error.invalidArguments');
    return this.exclusive(async () => {
      if (this.snapshot.connection !== 'stopped') throw new Error('error.debuggerNotStopped');
      const session = this.session;
      const results: DebuggerBreakpointResult[] = [];
      for (const input of parsed.data) {
        const location = input.trim();
        try {
          if (session !== this.session) throw new Error('error.debuggerSessionChanged');
          const existing = this.snapshot.breakpoints.find((b) => b.location === location);
          if (existing) results.push({ location, id: existing.id, status: 'existing' });
          else results.push({ location, id: await this.breakpointRaw(location), status: 'added' });
        } catch (error) {
          results.push({
            location,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    });
  }
  async assemble(address: number, source: string): Promise<string> {
    if (!this.profile.canAssemble) throw new Error('error.debuggerArchitectureUnsupported');
    const parsed = debuggerAssembleSchema.safeParse({ address, source });
    if (!parsed.success) throw new Error('error.invalidArguments');
    const gdb = (await this.tools(this.debugConfig)).gdb;
    if (!gdb) throw new Error('error.debuggerToolsMissing');
    return assembleThumbInstruction(await assemblerToolsFromGdb(gdb), address, source);
  }
  private interruptStop(timeoutMs = 12000) {
    let timer: ReturnType<typeof setTimeout>;
    let waiter: { resolve: (data: Record<string, MiValue>) => void; reject: (error: Error) => void };
    const promise = new Promise<Record<string, MiValue>>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.stopWaiters.delete(waiter);
      };
      waiter = {
        resolve: (data) => {
          cleanup();
          resolve(data);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.stopWaiters.add(waiter);
      timer = setTimeout(() => waiter.reject(new Error('error.debuggerTimeout')), timeoutMs);
    });
    // The interrupt command can fail before the asynchronous stop arrives.
    void promise.catch(() => {});
    return { promise, cancel: (error: Error) => waiter.reject(error) };
  }
  async patch(request: DebuggerPatchRequest): Promise<DebuggerPatchResult> {
    if (!this.profile.canPatchInstructions) throw new Error('error.debuggerArchitectureUnsupported');
    const parsed = debuggerPatchSchema.safeParse(request);
    if (!parsed.success) throw new Error('error.invalidArguments');
    if (parsed.data.sessionId !== this.snapshot.sessionId) throw new Error('error.debuggerSessionChanged');
    const hex = (value: string) => {
      if (!/^[\da-fA-F\s]+$/.test(value)) throw new Error('error.debuggerPatchBytes');
      const normalized = value.replace(/\s/g, '').toLowerCase();
      if (!/^(?:[\da-f]{4}|[\da-f]{8})$/.test(normalized)) throw new Error('error.debuggerPatchBytes');
      // Cortex-M Thumb: the first halfword determines the width of this instruction.
      const halfword = Number.parseInt(normalized.slice(2, 4) + normalized.slice(0, 2), 16);
      const width = halfword >>> 11 >= 0b11101 ? 8 : 4;
      if (normalized.length !== width) throw new Error('error.debuggerPatchBytes');
      return normalized;
    };
    const expected = hex(parsed.data.expected),
      bytes = hex(parsed.data.bytes);
    const address = parsed.data.address;
    if (bytes.length !== expected.length || address % 2) throw new Error('error.debuggerPatchBytes');
    if (address < 0x20000000 || address + bytes.length / 2 > 0x20005000)
      throw new Error('error.debuggerPatchRamOnly');
    return this.exclusive(async () => {
      if (!this.gdb) throw new Error('error.debuggerDisconnected');
      if (parsed.data.sessionId !== this.snapshot.sessionId) throw new Error('error.debuggerSessionChanged');
      const instruction = this.snapshot.instructions?.find((item) => Number(item.address) === address);
      if (!instruction || instruction.opcodes?.replace(/\s/g, '').toLowerCase() !== expected)
        throw new Error('error.debuggerPatchInstruction');
      const session = this.session;
      const running = this.snapshot.connection === 'running';
      let ownedStop = false;
      if (running) {
        if (!parsed.data.pauseAndResume) throw new Error('error.debuggerPatchPauseRequired');
        const stop = this.interruptStop();
        try {
          await this.command('-exec-interrupt --all');
          const event = await stop.promise;
          ownedStop =
            str(event['signal-name']) === 'SIGINT' &&
            (!str(event.reason) || str(event.reason) === 'signal-received');
          if (!ownedStop) throw new Error('error.debuggerPatchInterrupted');
        } catch (error) {
          stop.cancel(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
      const revision = this.stopRevision;
      const check = () => {
        if (session !== this.session || !this.gdb) throw new Error('error.debuggerSessionChanged');
        if (revision !== this.stopRevision || this.snapshot.connection !== 'stopped')
          throw new Error('error.debuggerPatchInterrupted');
      };
      check();
      const before = await this.readMemory(address, expected.length / 2);
      check();
      if (before.toLowerCase() !== expected) throw new Error('error.debuggerPatchChanged');
      await this.command(`-data-write-memory-bytes 0x${address.toString(16)} ${bytes}`);
      check();
      const after = await this.readMemory(address, bytes.length / 2);
      check();
      if (after.toLowerCase() !== bytes) throw new Error('error.debuggerPatchVerify');
      await this.refresh();
      check();
      let resumed = false;
      if (running && ownedStop && !this.keepPaused) {
        // Once resume is sent, a second pause must not be acknowledged without
        // sending an interrupt. Let that caller retry after this operation finishes.
        this.permitPauseRequest = false;
        await this.command('-exec-continue');
        if (revision === this.stopRevision) this.snapshot.connection = 'running';
        resumed = this.snapshot.connection === 'running';
      }
      return { address, before, after, resumed };
    }, true);
  }
  async memory(address: number, length: number) {
    if (this.editing) throw new Error('error.debuggerBusy');
    return this.readMemory(address, length);
  }
  private async readMemory(address: number, length: number) {
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
    const blocks = list(data.memory)
      .map(object)
      .sort((a, b) => Number(str(a.begin)) - Number(str(b.begin)));
    let cursor = address,
      contents = '';
    for (const block of blocks) {
      const bytes = str(block.contents);
      if (Number(str(block.begin)) !== cursor || !/^(?:[\da-fA-F]{2})+$/.test(bytes))
        throw new Error('error.debuggerMemoryIncomplete');
      cursor += bytes.length / 2;
      if (Number(str(block.end)) !== cursor) throw new Error('error.debuggerMemoryIncomplete');
      contents += bytes;
    }
    if (cursor !== address + length) throw new Error('error.debuggerMemoryIncomplete');
    return contents;
  }
  async disconnect(state: 'disconnected' | 'error' = 'disconnected') {
    if (this.disconnecting) return this.disconnecting;
    const task = this.disconnectNow(state);
    this.disconnecting = task;
    try {
      await task;
    } finally {
      if (this.disconnecting === task) this.disconnecting = undefined;
    }
  }
  private async releaseUartTarget() {
    const session = this.session;
    const deadline = Date.now() + 2500;
    const withinDeadline = async <T>(task: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          task,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('error.debuggerTimeout')),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const check = () => {
      if (session !== this.session || !this.gdb) throw new Error('error.debuggerSessionChanged');
      if (Date.now() >= deadline) throw new Error('error.debuggerTimeout');
    };
    let wait: ReturnType<HardwareDebugger['interruptStop']> | undefined;
    this.keepPaused = false;
    try {
      // Let an already-issued continue/break command settle before observing the target state.
      if (this.editSettled) await withinDeadline(this.editSettled);
      if (this.refreshTask) await withinDeadline(this.refreshTask).catch(() => {});
      check();
      if (this.profile.capabilities?.breakpoints !== false) {
        // Include GDB's temporary next/finish breakpoints, which are not in the UI list.
        let ownedStop = false;
        this.permitPauseRequest = true;
        if (this.snapshot.connection === 'running') {
          wait = this.interruptStop(Math.max(1, deadline - Date.now()));
          await withinDeadline(this.command('-exec-interrupt --all'));
          const event = await withinDeadline(wait.promise);
          ownedStop =
            str(event['signal-name']) === 'SIGINT' &&
            (!str(event.reason) || str(event.reason) === 'signal-received');
        }
        check();
        if (this.snapshot.connection !== 'stopped') throw new Error('error.debuggerNotStopped');
        const revision = this.stopRevision;
        await withinDeadline(this.command('-break-delete'));
        check();
        this.snapshot.breakpoints = [];
        // An intervening breakpoint/user pause must never be resumed by disconnect cleanup.
        if (
          ownedStop &&
          !this.keepPaused &&
          revision === this.stopRevision &&
          this.snapshot.connection === 'stopped'
        ) {
          this.permitPauseRequest = false;
          await withinDeadline(this.command('-exec-continue'));
          check();
          if (revision === this.stopRevision) this.snapshot.connection = 'running';
        }
      }
      this.permitPauseRequest = false;
      // No D/kill packet: legacy IDF stubs do not implement standard detach and it may resume.
      await withinDeadline(this.command('-target-disconnect'));
    } catch (error) {
      this.log('UART disconnect: ' + String(error));
    } finally {
      this.permitPauseRequest = false;
      wait?.cancel(new Error('error.debuggerDisconnected'));
    }
  }
  private async disconnectNow(state: 'disconnected' | 'error') {
    this.usbPreflightAbort?.abort();
    this.usbPreflightAbort = undefined;
    if (state === 'disconnected' && this.uartBridge && this.gdb) {
      await this.releaseUartTarget();
    }
    const gdb = this.gdb,
      server = this.server,
      uart = this.uartBridge;
    this.gdb = null;
    this.server = null;
    this.uartBridge = undefined;
    this.session++;
    this.refreshTask = undefined;
    this.keepPaused = true;
    for (const waiter of this.stopWaiters) waiter.reject(new Error('error.debuggerDisconnected'));
    this.stopWaiters.clear();
    this.snapshot.connection = state;
    if (state === 'disconnected') this.snapshot.message = '';
    delete this.snapshot.sessionId;
    this.snapshot.registers = [];
    this.snapshot.instructions = [];
    this.snapshot.stack = [];
    this.snapshot.breakpoints = [];
    delete this.snapshot.programCounter;
    delete this.snapshot.updatedAt;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('error.debuggerDisconnected'));
    }
    this.pending.clear();
    this.executionTokens.clear();
    if (uart) {
      await uart.close();
      this.uartPort = undefined;
    }
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
