import * as z from 'zod';
import { HardwareDebugger } from './hardware-debugger';
import type { RuntimePlugins } from './runtime-plugins';
import type { DebuggerAction, DebuggerState, DebuggerStorage, ProjectConfig } from '../shared/contracts';
import type { RuntimePluginInfo } from '../shared/plugins';
import { getDebuggerProfile } from '../shared/debugger-profiles';
import type { AutomaticDebugSymbolResolver } from './build-debug-symbols';
import {
  breakpointLocationsSchema,
  debuggerPatchSchema,
  debuggerAssembleSchema,
  type DebuggerPatchRequest,
  type DebuggerPatchResult,
  type DebuggerBreakpointResult,
} from '../shared/debugger-edit';

const text = z.string().max(16384);
const debuggerStateSchema = z.object({
  profile: z
    .object({
      id: z.enum(['STM32F103C8T6', 'Esp32_S3_CAM']),
      architecture: z.enum(['arm-thumb', 'xtensa']),
      elfMachine: z.number().int(),
      gdbName: text,
      serverName: text,
      transport: z.enum(['swd', 'usb-jtag', 'uart-gdb']),
      capabilities: z
        .object({
          continue: z.boolean(),
          pause: z.boolean(),
          step: z.boolean(),
          breakpoints: z.boolean(),
          memoryRead: z.boolean(),
        })
        .optional(),
      canPatchInstructions: z.boolean(),
      canAssemble: z.boolean(),
      registerNames: z.array(text).max(128),
      stackPointer: text,
      statusRegister: text,
      memoryRegions: z
        .array(
          z.object({
            name: text,
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            kind: z.enum(['ram', 'flash']),
          }),
        )
        .max(32),
    })
    .optional(),
  sessionId: z.string().max(128).optional(),
  connection: z.enum(['disconnected', 'connecting', 'stopped', 'running', 'error']),
  tools: z.object({
    gdb: z.boolean(),
    server: z.boolean(),
    paths: z
      .object({ gdb: text.nullable(), server: text.nullable(), scripts: text.nullable().optional() })
      .optional(),
  }),
  message: text,
  symbols: text,
  registers: z.array(z.object({ name: text, value: text })).max(4096),
  stack: z
    .array(
      z.object({ level: text, function: text, file: text.optional(), line: text.optional(), address: text }),
    )
    .max(4096),
  breakpoints: z.array(z.object({ id: text, location: text })).max(4096),
  log: z.array(text).max(4096),
  instructions: z
    .array(
      z.object({
        address: text,
        function: text.optional(),
        offset: text.optional(),
        instruction: text,
        opcodes: text.optional(),
      }),
    )
    .max(8192)
    .optional(),
  updatedAt: text.optional(),
  programCounter: text.optional(),
});
const storageSchema = z
  .object({
    name: text,
    size: z.number().int().nonnegative(),
    source: z.literal('elf'),
    preview: text,
    segments: z
      .array(
        z.object({
          address: z.number().int().nonnegative(),
          size: z.number().int().nonnegative(),
          kind: z.enum(['flash', 'ram', 'other']),
        }),
      )
      .max(4096),
  })
  .nullable();
const empty = (message = ''): DebuggerState => ({
  connection: 'disconnected',
  tools: { gdb: false, server: false },
  message,
  symbols: '',
  registers: [],
  stack: [],
  breakpoints: [],
  log: [],
});

/** One debugger owner routes the existing API to built-in or approved plugin providers. */
export class RuntimeDebugger extends HardwareDebugger {
  private providerId: string | undefined;
  private providerActive = false;
  private selectedConfig: ProjectConfig | undefined;
  private configurationRevision = 0;
  private connectingProvider = false;
  private connectionRevision = 0;
  constructor(
    root: string,
    dataRoot: string,
    emit: ((message: string) => void) | undefined,
    private readonly plugins: () => RuntimePlugins | undefined,
    private readonly config: () => ProjectConfig | undefined,
    automaticSymbols?: AutomaticDebugSymbolResolver,
  ) {
    super(root, dataRoot, emit, automaticSymbols);
  }
  override get active() {
    return this.providerActive || super.active;
  }
  async invokePlugin(id: string, method: string, args: unknown[]): Promise<unknown> {
    if (id !== (this.providerId ?? this.config()?.boardId)) throw new Error('error.runtimePluginConfig');
    const string = (index: number, max = 4096) => {
      const value = args[index];
      if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value))
        throw new Error('rpc.invalidParams');
      return value;
    };
    switch (method) {
      case 'state':
        return this.state();
      case 'storage':
        return this.storage();
      case 'connect': {
        const config = this.config();
        if (!config || config.boardId !== id) throw new Error('error.runtimePluginConfig');
        return this.connect(config);
      }
      case 'disconnect':
        return this.disconnect();
      case 'memory':
        return this.memory(z.number().parse(args[0]), z.number().parse(args[1]));
      case 'breakpoint':
        return this.breakpoint(string(0, 1024), args[1] === undefined ? undefined : string(1, 80));
      case 'breakpoints':
        return this.breakpoints(breakpointLocationsSchema.parse(args[0]));
      case 'patch':
        return this.patch(debuggerPatchSchema.parse(args[0]));
      case 'assemble':
        return this.assemble(z.number().parse(args[0]), string(1, 512));
      case 'symbolsFile':
        return this.symbolsFile(string(0));
      case 'selectGdb':
        return this.selectGdb(string(0));
      case 'action': {
        const action = string(0, 128);
        if (['continue', 'pause', 'step', 'next', 'finish', 'disconnect'].includes(action))
          return this.action(action as DebuggerAction);
        if (!this.providerActive) throw new Error('error.debuggerDisconnected');
        return this.plugins()!.invokeDebug(id, 'action', args);
      }
      default:
        throw new Error('error.runtimePluginCapability');
    }
  }
  private async selection(
    id = this.providerId ?? this.selectedConfig?.boardId ?? this.config()?.boardId,
  ): Promise<RuntimePluginInfo | undefined> {
    if (!id) return undefined;
    return (await this.plugins()?.state())?.plugins.find((item) => item.id === id);
  }
  private async invoke<T>(
    plugin: RuntimePluginInfo,
    method: string,
    args: unknown[],
    fallback: () => Promise<T>,
  ): Promise<T> {
    await this.plugins()!.assertTrusted(plugin.id, ['state', 'storage'].includes(method));
    const disabled =
      this.config()?.boardId === plugin.id ? this.config()?.runtime?.disabledCapabilities : undefined;
    if (
      !['state', 'disconnect'].includes(method) &&
      disabled?.some((value) => value === 'debug' || value === 'debugger')
    )
      throw new Error('error.runtimePluginCapability');
    if (plugin.manifest.debugger.mode === 'builtin') {
      if (!getDebuggerProfile(plugin.manifest.compiler.baseRuntime ?? ''))
        throw new Error('error.runtimeDebuggerUnsupported');
      return fallback();
    }
    if (plugin.manifest.debugger.mode === 'none') throw new Error('error.runtimeDebuggerUnsupported');
    try {
      return (await this.plugins()!.invokeDebug(plugin.id, method, args)) as T;
    } catch (error) {
      if (
        plugin.manifest.debugger.mode === 'extend' &&
        !!getDebuggerProfile(plugin.manifest.compiler.baseRuntime ?? '') &&
        error instanceof Error &&
        error.message === 'error.runtimePluginCapability'
      )
        return fallback();
      throw error;
    }
  }
  override async state(config?: ProjectConfig): Promise<DebuggerState> {
    if (
      config &&
      !this.active &&
      !this.connectingProvider &&
      JSON.stringify(config) !== JSON.stringify(this.selectedConfig)
    ) {
      this.selectedConfig = structuredClone(config);
      this.configurationRevision++;
    }
    const revision = this.configurationRevision;
    const current = this.selectedConfig ?? this.config();
    const plugin = await this.selection();
    if (revision !== this.configurationRevision) return this.state();
    if (!plugin) return super.state(current);
    if (plugin.manifest.debugger.mode === 'none') return empty('error.runtimeDebuggerUnsupported');
    if (plugin.trust === 'required') return empty('error.runtimePluginTrustRequired');
    const native =
      current && plugin.manifest.compiler.baseRuntime
        ? { ...current, boardId: plugin.manifest.compiler.baseRuntime }
        : current;
    const base = plugin.manifest.debugger.mode === 'extend' ? await super.state(native) : empty();
    const result = await this.invoke<unknown>(
      plugin,
      'state',
      plugin.manifest.debugger.mode === 'extend' ? [base] : [],
      () => super.state(native),
    );
    if (revision !== this.configurationRevision) return this.state();
    const parsed = debuggerStateSchema.safeParse(
      plugin.manifest.debugger.mode === 'extend' && result && typeof result === 'object'
        ? { ...base, ...result }
        : result,
    );
    if (!parsed.success) throw new Error('error.runtimePluginResult');
    return parsed.data;
  }
  override async connect(config: ProjectConfig): Promise<void> {
    if (this.active || this.connectingProvider) throw new Error('error.debuggerBusy');
    this.connectingProvider = true;
    const revision = ++this.connectionRevision;
    this.selectedConfig = structuredClone(config);
    this.configurationRevision++;
    let plugin: RuntimePluginInfo | undefined;
    try {
      plugin = await this.selection(config.boardId);
      if (revision !== this.connectionRevision) throw new Error('error.operationCancelled');
      if (!plugin) {
        await super.connect(config);
      } else {
        if (plugin.manifest.debugger.mode === 'none') throw new Error('error.runtimeDebuggerUnsupported');
        this.providerId = plugin.id;
        await this.invoke(plugin, 'connect', [config], () =>
          super.connect({ ...config, boardId: plugin!.manifest.compiler.baseRuntime! }),
        );
        if (revision !== this.connectionRevision) {
          // A provider may finish attaching after its earlier cancellation callback returned.
          await this.invoke(plugin, 'disconnect', [], async () => {}).catch(() => {});
          throw new Error('error.operationCancelled');
        }
        this.providerActive = true;
      }
    } catch (error) {
      this.providerId = undefined;
      this.providerActive = false;
      throw error;
    } finally {
      this.connectingProvider = false;
    }
  }
  override async action(action: DebuggerAction): Promise<void> {
    if (action === 'disconnect') return this.disconnect();
    const plugin = await this.selection(this.providerId);
    if (!plugin) return super.action(action);
    if (!this.providerActive) throw new Error('error.debuggerDisconnected');
    await this.invoke(plugin, 'action', [action], () => super.action(action));
  }
  override async disconnect(state: 'disconnected' | 'error' = 'disconnected'): Promise<void> {
    this.connectionRevision++;
    const id = this.providerId;
    try {
      const plugin = id ? await this.selection(id) : undefined;
      if (plugin) await this.invoke(plugin, 'disconnect', [], async () => {});
    } finally {
      this.providerActive = false;
      this.providerId = undefined;
      await super.disconnect(state);
    }
  }
  override async storage(): Promise<DebuggerStorage | null> {
    const plugin = await this.selection();
    if (!plugin) return super.storage();
    if (plugin.trust === 'required' || plugin.manifest.debugger.mode === 'none') return null;
    let result: unknown;
    try {
      result = await this.invoke(plugin, 'storage', [], () => super.storage());
    } catch (error) {
      if (error instanceof Error && error.message === 'error.runtimePluginCapability') return null;
      throw error;
    }
    const parsed = storageSchema.safeParse(result);
    if (!parsed.success) throw new Error('error.runtimePluginResult');
    return parsed.data;
  }
  override async memory(address: number, length: number): Promise<string> {
    if (
      !Number.isInteger(address) ||
      address < 0 ||
      address > 0xffffffff ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > 4096
    )
      throw new Error('rpc.invalidParams');
    const plugin = await this.selection();
    if (!plugin) return super.memory(address, length);
    const result = await this.invoke<unknown>(plugin, 'memory', [address, length], () =>
      super.memory(address, length),
    );
    if (typeof result !== 'string' || result.length > 32768) throw new Error('error.runtimePluginResult');
    return result;
  }
  override async breakpoint(location: string, removeId?: string): Promise<void> {
    const plugin = await this.selection();
    if (!plugin) return super.breakpoint(location, removeId);
    await this.invoke(plugin, 'breakpoint', [location, removeId], () => super.breakpoint(location, removeId));
  }
  override async breakpoints(locations: string[]): Promise<DebuggerBreakpointResult[]> {
    const parsed = breakpointLocationsSchema.safeParse(locations);
    if (!parsed.success) throw new Error('rpc.invalidParams');
    const plugin = await this.selection();
    if (!plugin) return super.breakpoints(locations);
    const result = await this.invoke<unknown>(plugin, 'breakpoints', [locations], () =>
      super.breakpoints(locations),
    );
    const output = z
      .array(
        z.object({
          location: text,
          id: text.optional(),
          status: z.enum(['added', 'existing', 'failed']),
          error: text.optional(),
        }),
      )
      .max(128)
      .safeParse(result);
    if (!output.success || output.data.length !== locations.length)
      throw new Error('error.runtimePluginResult');
    return output.data;
  }
  override async patch(request: DebuggerPatchRequest): Promise<DebuggerPatchResult> {
    const parsed = debuggerPatchSchema.safeParse(request);
    if (!parsed.success) throw new Error('rpc.invalidParams');
    const plugin = await this.selection();
    if (!plugin) return super.patch(parsed.data);
    if ((await this.state()).sessionId !== parsed.data.sessionId)
      throw new Error('error.debuggerSessionChanged');
    const result = await this.invoke<unknown>(plugin, 'patch', [parsed.data], () => super.patch(parsed.data));
    const output = z
      .object({
        address: z.number().int().nonnegative().max(0xffffffff),
        before: z.string().regex(/^(?:[\da-fA-F]{4}|[\da-fA-F]{8})$/),
        after: z.string().regex(/^(?:[\da-fA-F]{4}|[\da-fA-F]{8})$/),
        resumed: z.boolean(),
      })
      .safeParse(result);
    if (!output.success) throw new Error('error.runtimePluginResult');
    return output.data;
  }
  override async assemble(address: number, source: string): Promise<string> {
    const parsed = debuggerAssembleSchema.safeParse({ address, source });
    if (!parsed.success) throw new Error('rpc.invalidParams');
    const plugin = await this.selection();
    if (!plugin) return super.assemble(address, source);
    const result = await this.invoke<unknown>(plugin, 'assemble', [address, source], () =>
      super.assemble(address, source),
    );
    if (typeof result !== 'string' || !/^(?:[\da-fA-F]{4}|[\da-fA-F]{8})$/.test(result))
      throw new Error('error.runtimePluginResult');
    return result;
  }
  override async symbolsFile(file: string): Promise<string> {
    const plugin = await this.selection();
    if (!plugin) return super.symbolsFile(file);
    const result = await this.invoke<unknown>(plugin, 'symbolsFile', [file], () => super.symbolsFile(file));
    if (typeof result !== 'string' || result.length > 4096) throw new Error('error.runtimePluginResult');
    return result;
  }
  override async symbolsBytes(bytes: Buffer, name: string): Promise<string> {
    const plugin = await this.selection();
    if (!plugin) return super.symbolsBytes(bytes, name);
    const result = await this.invoke<unknown>(plugin, 'symbolsBytes', [bytes, name], () =>
      super.symbolsBytes(bytes, name),
    );
    if (typeof result !== 'string' || result.length > 4096) throw new Error('error.runtimePluginResult');
    return result;
  }
  override async selectGdb(file: string, expectedProfileId?: string): Promise<void> {
    const plugin = await this.selection();
    if (!plugin) return super.selectGdb(file, expectedProfileId);
    if (expectedProfileId && (await this.state()).profile?.id !== expectedProfileId)
      throw new Error('error.debuggerSessionChanged');
    await this.invoke(plugin, 'selectGdb', [file], () => super.selectGdb(file, expectedProfileId));
  }
  override async install(...args: Parameters<HardwareDebugger['install']>): Promise<void> {
    if (this.connectingProvider) throw new Error('error.debuggerBusy');
    if (args[2]?.config && !this.active) {
      this.selectedConfig = structuredClone(args[2].config);
      this.configurationRevision++;
    }
    const config = this.selectedConfig ?? this.config();
    const plugin = await this.selection();
    if (!plugin) return super.install(args[0], args[1], { ...args[2], config });
    await this.invoke(plugin, 'install', args, () =>
      super.install(args[0], args[1], {
        ...args[2],
        config:
          config && plugin.manifest.compiler.baseRuntime
            ? { ...config, boardId: plugin.manifest.compiler.baseRuntime }
            : config,
      }),
    );
  }
}
