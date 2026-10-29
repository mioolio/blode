import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as z from 'zod';
import { canonicalBoardId, getBoardAdapter, registerBoardAdapter } from '../../extensions/registry';
import type { BoardAdapter } from '../../extensions/types';
import type { PlatformRuntime, RuntimeHost } from '../../extensions/runtime';
import type { PluginPlatformRuntime, PluginRuntimeHost, RuntimePluginModule } from '../../extensions/plugins';
import type { BuildResult, ProjectBuildInputs, ProjectConfig, ToolchainStatus } from '../shared/contracts';
import type {
  RuntimePluginInfo,
  RuntimePluginManifest,
  RuntimePluginsState,
  RuntimePluginTrustRequest,
} from '../shared/plugins';
import { parseRuntimePluginManifest } from './runtime-plugin-schema';
import { configSchema } from './config';

interface Options {
  roots: string[];
  dataRoot: string;
}
interface PackageRecord {
  directory: string;
  manifest: RuntimePluginManifest;
  fingerprint: string;
  trust: RuntimePluginInfo['trust'];
  sessionFingerprint?: string;
  instance?: PluginPlatformRuntime;
  pending?: Promise<PluginPlatformRuntime>;
  loadedFingerprint?: string;
  restartRequired?: boolean;
  wrapper?: PlatformRuntime;
  fileHashes: Map<string, { signature: string; hash: string }>;
  checkedAt: number;
  unregister: () => void;
  lastError?: string;
}
const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const trustSchema = z
  .object({
    id: idSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
    permanent: z.boolean(),
  })
  .strict();
const relativeFile = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.split(/[\\/]/).some((part) => part === '..') &&
      !/[\0\r\n]/.test(value),
  );
const buildResultSchema = z
  .object({
    success: z.boolean(),
    flashUsed: z.number().int().nonnegative(),
    ramUsed: z.number().int().nonnegative(),
    flashTotal: z.number().int().nonnegative(),
    ramTotal: z.number().int().nonnegative(),
    artifacts: z.array(relativeFile).max(1000),
    timestamp: z.string().max(128),
    output: z.string().max(8_000_000),
  })
  .strict();
const candidateSchema = z
  .object({
    id: z.string().min(1).max(256),
    platformId: idSchema,
    transport: z.enum(['serial', 'stlink', 'usb', 'physical', 'custom']),
    name: z.string().max(1024),
    port: z.string().max(4096).optional(),
    serialNumber: z.string().max(256).optional(),
    deviceId: z.string().max(4096).optional(),
    debugProbe: z
      .object({
        serialNumber: z.string(),
        name: z.string(),
        chipId: z.string().optional(),
        description: z.string().optional(),
        flashSize: z.number().optional(),
        ramSize: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const debugMethods = new Set([
  'state',
  'connect',
  'disconnect',
  'action',
  'storage',
  'symbolsFile',
  'symbolsBytes',
  'selectGdb',
  'breakpoint',
  'memory',
  'install',
  'restore',
]);
const emptyStatus = (): ToolchainStatus => ({
  arduinoCli: false,
  esp32Core: false,
  python: false,
  esptool: false,
  versions: {},
});
const toolStatusSchema = z
  .object({
    arduinoCli: z.boolean(),
    esp32Core: z.boolean(),
    python: z.boolean(),
    esptool: z.boolean(),
    stlink: z.boolean().optional(),
    armCompiler: z.boolean().optional(),
    gnuArm: z.boolean().optional(),
    versions: z.record(z.string().max(128), z.string().max(4096)),
  })
  .strict();
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function fail(message: string): never {
  throw new Error(message);
}

/** Native extensions execute with host privileges after an explicit, package-bound decision. */
export class RuntimePlugins {
  private packages = new Map<string, PackageRecord>();
  private errors: RuntimePluginsState['errors'] = [];
  private host?: RuntimeHost;
  private builtins: PlatformRuntime[] = [];
  private key?: Buffer;
  private closed = false;
  constructor(private readonly options: Options) {}
  private async packageFile(record: Pick<PackageRecord, 'directory'>, relative: string) {
    if (!relativeFile.safeParse(relative).success || relative.replaceAll('\\', '/') === '.uel')
      fail('error.runtimePluginPath');
    const candidate = path.resolve(record.directory, relative);
    if (!inside(record.directory, candidate)) fail('error.runtimePluginPath');
    const actual = await fs.realpath(candidate).catch(() => fail('error.runtimePluginPath'));
    const stat = await fs.lstat(candidate).catch(() => fail('error.runtimePluginPath'));
    if (!inside(record.directory, actual) || !stat.isFile() || stat.isSymbolicLink())
      fail('error.runtimePluginPath');
    return actual;
  }
  private async fingerprint(record: PackageRecord, execute = false) {
    if (!execute && Date.now() - record.checkedAt < 5000) return record.fingerprint;
    const hash = createHash('sha256');
    let total = 0;
    const files: string[] = [];
    const walk = async (directory: string, depth: number) => {
      if (depth > 24) fail('error.runtimePluginSize');
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        if (entry.name === '.uel' && directory === record.directory) continue;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) fail('error.runtimePluginPath');
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        files.push(full);
        if (files.length > 20_000) fail('error.runtimePluginSize');
      }
    };
    await walk(record.directory, 0);
    // Bound concurrency and stream native compiler payloads rather than buffering them.
    for (let index = 0; index < files.length; index += 16) {
      const entries = await Promise.all(
        files.slice(index, index + 16).map(async (full) => {
          const stat = await fs.stat(full);
          const relative = path.relative(record.directory, full).replaceAll('\\', '/');
          if ((total += stat.size) > 4 * 1024 ** 3 || stat.size > 2 * 1024 ** 3)
            fail('error.runtimePluginSize');
          const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          const old = record.fileHashes.get(relative);
          const business = /\.(?:[cm]?js|json|html?|ts|py|ps1|sh|uel)$/i.test(relative);
          let digest = old?.signature === signature && !(execute && business) ? old.hash : '';
          if (!digest) {
            const contentHash = createHash('sha256');
            for await (const chunk of createReadStream(full)) contentHash.update(chunk);
            digest = contentHash.digest('hex');
          }
          record.fileHashes.set(relative, { signature, hash: digest });
          if (relative === 'manifest.json' && old && old.hash !== digest) record.restartRequired = true;
          return relative + '\0' + digest + '\n';
        }),
      );
      for (const entry of entries) hash.update(entry);
    }
    const fingerprint = hash.digest('hex');
    record.checkedAt = Date.now();
    if (record.fingerprint && fingerprint !== record.fingerprint) {
      record.trust = 'required';
      record.sessionFingerprint = undefined;
      if (record.loadedFingerprint) record.restartRequired = true;
    }
    record.fingerprint = fingerprint;
    return fingerprint;
  }
  private async signingKey() {
    if (this.key) return this.key;
    const directory = path.join(path.resolve(this.options.dataRoot), 'plugin-security');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'trust-key');
    const existing = await fs.lstat(file).catch(() => null);
    if (existing?.isSymbolicLink() || (existing && (!existing.isFile() || existing.size !== 32)))
      fail('error.runtimePluginTrustStore');
    if (!existing) {
      try {
        await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) fail('error.runtimePluginTrustStore');
    this.key = await fs.readFile(file);
    return this.key;
  }
  private async permanent(record: PackageRecord) {
    const marker = path.join(record.directory, '.uel');
    const stat = await fs.lstat(marker).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
    try {
      const declaration = JSON.parse(await fs.readFile(marker, 'utf8'));
      if (
        declaration.id !== record.manifest.id ||
        declaration.fingerprint !== record.fingerprint ||
        declaration.suppressWarning !== true ||
        typeof declaration.signature !== 'string' ||
        !/^[a-f0-9]{64}$/.test(declaration.signature)
      )
        return false;
      const signature = createHmac('sha256', await this.signingKey())
        .update(
          JSON.stringify({
            id: record.manifest.id,
            directory: record.directory,
            fingerprint: record.fingerprint,
            suppressWarning: true,
          }),
        )
        .digest();
      return timingSafeEqual(signature, Buffer.from(declaration.signature, 'hex'));
    } catch {
      return false;
    }
  }
  private async check(record: PackageRecord, execute = false) {
    if (this.closed) fail('error.runtimePluginClosed');
    const directory = await fs.lstat(record.directory).catch(() => null);
    if (!directory?.isDirectory() || directory.isSymbolicLink()) fail('error.runtimePluginPath');
    await this.fingerprint(record, execute);
    if (record.restartRequired) {
      record.trust = 'required';
      return false;
    }
    record.trust = (await this.permanent(record))
      ? 'permanent'
      : record.sessionFingerprint === record.fingerprint
        ? 'session'
        : 'required';
    return record.trust !== 'required';
  }
  private async trusted(record: PackageRecord) {
    const allowed = await this.check(record, true);
    if (record.restartRequired) fail('error.runtimePluginRestartRequired');
    if (!allowed) fail('error.runtimePluginTrustRequired');
    // Recheck package-bound entry points after authorization and before import.
    await this.packageFile(record, record.manifest.runtime);
  }
  async discover(): Promise<RuntimePluginsState> {
    if (this.packages.size) return this.state();
    for (const root of [...new Set(this.options.roots.map((root) => path.resolve(root)))]) {
      const info = await fs.lstat(root).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const actualRoot = await fs.realpath(root);
      for (const entry of (await fs.readdir(actualRoot, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const directory = path.join(actualRoot, entry.name);
        let registered: (() => void) | undefined;
        try {
          const file = path.join(directory, 'manifest.json');
          const stat = await fs.lstat(file).catch(() => null);
          if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 256_000) continue;
          const json = JSON.parse(await fs.readFile(file, 'utf8'));
          // Trusted built-ins are bundled statically, never replaced by a directory's code.
          let registeredBoard = false;
          try {
            getBoardAdapter(json.id);
            registeredBoard = true;
          } catch {}
          if (registeredBoard) {
            if (
              json.id === 'auto' ||
              ['Esp32_S3_CAM', 'STM32F103C8T6', 'esp32-s3', 'stm32'].includes(json.id)
            )
              continue;
            fail('error.runtimePluginDuplicate');
          }
          if (json.apiVersion !== 2) {
            if (json.kind === 'board') fail('error.runtimePluginManifest');
            continue;
          }
          const manifest = parseRuntimePluginManifest(json);
          if (
            manifest.id !== entry.name ||
            canonicalBoardId(manifest.id) !== manifest.id ||
            this.packages.has(manifest.id)
          )
            fail('error.runtimePluginDuplicate');
          const record: PackageRecord = {
            directory,
            manifest,
            fingerprint: '',
            trust: 'required',
            fileHashes: new Map(),
            checkedAt: 0,
            unregister: () => {},
          };
          await this.packageFile(record, manifest.runtime);
          if (manifest.compiler.defaultTool)
            await this.packageFile(record, manifest.compiler.defaultTool.executable);
          if (manifest.debugger.view) await this.packageFile(record, manifest.debugger.view);
          if (manifest.ui.view) await this.packageFile(record, manifest.ui.view);
          await this.fingerprint(record, true);
          const config = structuredClone(manifest.defaultConfig);
          const defaults = Object.fromEntries(
            manifest.ui.fields
              .filter((field) => field.default !== undefined)
              .map((field) => [field.id, field.default!]),
          ) as Record<string, string | number | boolean>;
          config.runtime = { ...config.runtime, values: { ...defaults, ...config.runtime?.values } };
          const adapter: BoardAdapter = {
            definition: {
              id: manifest.id,
              name: manifest.name,
              family: manifest.support.families?.join(' / ') ?? manifest.support.chips.join(' / '),
              descriptionKey: manifest.descriptionKey ?? 'runtime.pluginDescription',
              flashSizes: manifest.layout.recommendedFlashSizes,
              customFlashSize: true,
              layout: { baseAddress: manifest.layout.flashBaseAddress ?? 0 },
              ramSize: manifest.layout.ramSize,
              defaultConfig: config,
              capabilities: manifest.capabilities,
              runtimePlugin: manifest,
            },
            createConfig: () => structuredClone(config),
            getFqbn: (value) => value.toolchain.fqbn,
            validateConfig: (value) => {
              if (value.boardId !== manifest.id) fail('error.runtimePluginConfig');
              this.chipConstraint(record, value.programmer?.targetChipId);
              const values = value.runtime?.values ?? {};
              for (const field of manifest.ui.fields) {
                const selected = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
                if (selected === undefined) continue;
                if (
                  (field.type === 'boolean' && typeof selected !== 'boolean') ||
                  (field.type === 'number' &&
                    (typeof selected !== 'number' ||
                      !Number.isFinite(selected) ||
                      (field.min !== undefined && selected < field.min) ||
                      (field.max !== undefined && selected > field.max))) ||
                  (['text', 'select'].includes(field.type) && typeof selected !== 'string') ||
                  (field.type === 'select' && !field.options?.some((option) => option.value === selected))
                )
                  fail('error.runtimePluginConfig');
              }
            },
          };
          registered = registerBoardAdapter(adapter);
          record.unregister = registered;
          this.packages.set(manifest.id, record);
        } catch (error) {
          registered?.();
          this.errors.push({
            directory,
            message: error instanceof Error ? error.message : 'error.runtimePluginManifest',
          });
        }
      }
    }
    return this.state();
  }
  async state(): Promise<RuntimePluginsState> {
    const plugins: RuntimePluginInfo[] = [];
    for (const record of this.packages.values()) {
      try {
        await this.check(record);
      } catch (error) {
        record.trust = 'required';
        this.report(record, error);
      }
      plugins.push({
        id: record.manifest.id,
        name: record.manifest.name,
        directory: record.directory,
        fingerprint: record.fingerprint,
        trust: record.trust,
        restartRequired: record.restartRequired,
        manifest: structuredClone(record.manifest),
      });
    }
    return {
      plugins,
      errors: structuredClone(
        [
          ...this.errors,
          ...[...this.packages.values()]
            .filter((record) => record.lastError)
            .map((record) => ({ directory: record.directory, message: record.lastError! })),
        ].slice(0, 200),
      ),
    };
  }
  async trust(input: RuntimePluginTrustRequest) {
    const request = trustSchema.parse(input);
    const record = this.record(request.id);
    await this.fingerprint(record, true);
    if (record.restartRequired) fail('error.runtimePluginRestartRequired');
    if (record.fingerprint !== request.fingerprint) fail('error.runtimePluginChanged');
    if (request.permanent) {
      const data = {
        id: record.manifest.id,
        directory: record.directory,
        fingerprint: record.fingerprint,
        suppressWarning: true,
      };
      const signature = createHmac('sha256', await this.signingKey())
        .update(JSON.stringify(data))
        .digest('hex');
      const file = path.join(record.directory, '.uel');
      const existing = await fs.lstat(file).catch(() => null);
      if (existing?.isSymbolicLink() || (existing && (!existing.isFile() || existing.nlink > 1)))
        fail('error.runtimePluginPath');
      await fs.writeFile(file, JSON.stringify({ ...data, signature }, null, 2) + '\n', { mode: 0o600 });
      record.sessionFingerprint = undefined;
    } else record.sessionFingerprint = record.fingerprint;
    return this.state();
  }
  private record(id: string) {
    return this.packages.get(id) ?? fail('error.runtimePluginMissing');
  }
  private report(record: PackageRecord, error: unknown) {
    record.lastError = (error instanceof Error ? error.message : 'error.runtimePluginResult').slice(0, 2048);
  }
  async assertTrusted(id: string, passive = false): Promise<void> {
    const record = this.record(id);
    if (!passive) {
      await this.trusted(record);
      return;
    }
    const allowed = await this.check(record);
    if (record.restartRequired) fail('error.runtimePluginRestartRequired');
    if (!allowed) fail('error.runtimePluginTrustRequired');
  }
  private chipConstraint(record: PackageRecord, chipId?: string) {
    if (!chipId || !record.manifest.constraints.chipIds?.length) return;
    const actual = Number.parseInt(chipId, 16);
    if (
      !Number.isFinite(actual) ||
      !record.manifest.constraints.chipIds.some((allowed) => Number.parseInt(allowed, 16) === actual)
    )
      fail('error.runtimePluginChip');
  }
  private capability(record: PackageRecord, config: ProjectConfig, capability: string) {
    if (
      !record.manifest.capabilities.includes(capability) ||
      config.runtime?.disabledCapabilities?.includes(capability)
    )
      fail('error.runtimePluginCapability');
    this.chipConstraint(record, config.programmer?.targetChipId);
  }
  private async load(record: PackageRecord, readCached = false): Promise<PluginPlatformRuntime> {
    if (readCached && record.instance) {
      const allowed = await this.check(record);
      if (record.restartRequired) fail('error.runtimePluginRestartRequired');
      if (!allowed) fail('error.runtimePluginTrustRequired');
    } else await this.trusted(record);
    if (record.instance) return record.instance;
    if (record.pending) return record.pending;
    const pending = (async () => {
      const moduleUrl = pathToFileURL(await this.packageFile(record, record.manifest.runtime));
      moduleUrl.searchParams.set('blode', record.fingerprint);
      record.loadedFingerprint = record.fingerprint;
      const module = (await import(/* @vite-ignore */ moduleUrl.href)) as RuntimePluginModule;
      if (typeof module.createRuntime !== 'function' || !this.host) fail('error.runtimePluginModule');
      let defaultTool: PluginRuntimeHost['defaultTool'];
      if (record.manifest.compiler.defaultTool) {
        const tool = record.manifest.compiler.defaultTool;
        const executable = await this.packageFile(record, tool.executable);
        defaultTool = {
          id: tool.id,
          command: tool.runner === 'node' ? process.execPath : executable,
          args: [...(tool.runner === 'node' ? [executable] : []), ...(tool.args ?? [])],
          version: tool.version,
          ...(tool.runner === 'node' && process.versions.electron
            ? { env: { ...this.host!.env, ELECTRON_RUN_AS_NODE: '1' } }
            : {}),
        };
      }
      const host: PluginRuntimeHost = {
        ...this.host!,
        pluginRoot: record.directory,
        defaultTool,
        runDefaultTool: async (extra = []) => {
          if (!defaultTool) fail('error.runtimePluginCompiler');
          return this.host!.runCommand(defaultTool.command, [...defaultTool.args, ...extra], {
            cwd: this.host!.projectRoot(),
            env: defaultTool.env ?? this.host!.env,
            signal: this.host!.signal,
            timeout: 900_000,
          });
        },
      };
      const instance = await module.createRuntime(host, structuredClone(record.manifest));
      if (
        !instance ||
        instance.id !== record.manifest.id ||
        instance.transport !== record.manifest.transport ||
        ['build', 'discover', 'probe', 'status', 'install', 'flash', 'invalidate'].some(
          (method) => typeof (instance as any)[method] !== 'function',
        )
      )
        fail('error.runtimePluginModule');
      record.instance = instance;
      return instance;
    })();
    record.pending = pending;
    try {
      return await pending;
    } catch (error) {
      record.pending = undefined;
      throw error;
    }
  }
  attach(host: RuntimeHost, builtins: PlatformRuntime[]): PlatformRuntime[] {
    this.host = host;
    this.builtins = builtins;
    return [...this.packages.values()].map((record) => {
      const manifest = record.manifest;
      const base = (config?: ProjectConfig) =>
        this.builtins.find(
          (runtime) =>
            runtime.id ===
            canonicalBoardId(
              (config?.runtime?.forceCompiler ? config.runtime.compilerRuntime : undefined) ??
                manifest.compiler.baseRuntime ??
                '',
            ),
        ) ?? fail('error.runtimePluginCompiler');
      const forBase = (config: ProjectConfig): ProjectConfig => ({ ...config, boardId: base(config).id });
      const inputsForBase = (config: ProjectConfig, inputs: ProjectBuildInputs): ProjectBuildInputs => {
        const platform = inputs.settings?.platforms?.[config.boardId];
        return platform
          ? {
              ...inputs,
              settings: {
                ...inputs.settings,
                platforms: { ...inputs.settings?.platforms, [base(config).id]: platform },
              },
            }
          : inputs;
      };
      const build = async (config: ProjectConfig, inputs: ProjectBuildInputs): Promise<BuildResult> => {
        this.capability(record, config, 'compile');
        await this.trusted(record);
        const useHost =
          config.runtime?.forceCompiler === true ||
          (manifest.compiler.mode === 'host' && !manifest.compiler.forceComponent);
        const result = useHost
          ? await base(config).build(forBase(config), inputsForBase(config, inputs))
          : await (await this.load(record)).build(config, inputs);
        const parsed = buildResultSchema.safeParse(result);
        if (!parsed.success) fail('error.runtimePluginResult');
        for (const file of parsed.data.artifacts) await host.resolveWorkspacePath(file, { internal: true });
        return parsed.data;
      };
      const wrapper: PlatformRuntime = {
        id: manifest.id,
        transport: manifest.transport,
        sourceInputs: manifest.sourceInputs ?? [],
        build,
        async status(config, refresh) {
          try {
            if (!(await thisManager.check(record))) return emptyStatus();
            const result = await (await thisManager.load(record)).status(config, refresh);
            const parsed = toolStatusSchema.safeParse(result);
            if (!parsed.success) fail('error.runtimePluginResult');
            record.lastError = undefined;
            return parsed.data;
          } catch (error) {
            thisManager.report(record, error);
            return emptyStatus();
          }
        },
        async discover(config) {
          if (!(await thisManager.check(record))) return [];
          const result = await (await thisManager.load(record)).discover(config);
          const parsed = z.array(candidateSchema).max(1000).safeParse(result);
          if (
            !parsed.success ||
            parsed.data.some(
              (candidate) =>
                candidate.platformId !== manifest.id || candidate.transport !== manifest.transport,
            )
          )
            fail('error.runtimePluginResult');
          return parsed.data;
        },
        async install(config) {
          await thisManager.trusted(record);
          const result = await (await thisManager.load(record)).install(config);
          const parsed = toolStatusSchema.safeParse(result);
          if (!parsed.success) fail('error.runtimePluginResult');
          return parsed.data;
        },
        async probe(config, selection) {
          thisManager.capability(record, config, 'probe');
          const result = await (await thisManager.load(record)).probe(config, selection);
          const parsed = configSchema.safeParse(result?.config);
          if (
            !parsed.success ||
            parsed.data.boardId !== manifest.id ||
            typeof result.output !== 'string' ||
            result.output.length > 1_000_000
          )
            fail('error.runtimePluginResult');
          thisManager.chipConstraint(record, parsed.data.programmer?.targetChipId);
          for (const probe of result.debugProbes ?? []) thisManager.chipConstraint(record, probe.chipId);
          getBoardAdapter(manifest.id).validateConfig(parsed.data);
          return result;
        },
        async flash(config, result) {
          thisManager.capability(record, config, 'flash');
          await (await thisManager.load(record)).flash(config, result);
        },
        async flashPrepared(config, image) {
          thisManager.capability(record, config, 'flash');
          const runtime = await thisManager.load(record);
          if (!runtime.flashPrepared) fail('error.runtimePluginCapability');
          await runtime.flashPrepared(config, image);
        },
        async projectConfig(config, inputs) {
          if (config.boardId !== manifest.id) return null;
          const runtime = await thisManager.load(record);
          const result = (await runtime.projectConfig?.(config, inputs)) ?? null;
          if (result === null) return null;
          const parsed = configSchema.safeParse(result);
          if (!parsed.success) fail('error.runtimePluginResult');
          getBoardAdapter(manifest.id).validateConfig(parsed.data);
          return parsed.data;
        },
        async buildInputs(config, inputs) {
          await thisManager.trusted(record);
          if (
            (manifest.compiler.mode === 'host' && !manifest.compiler.forceComponent) ||
            config.runtime?.forceCompiler
          )
            return base(config).buildInputs?.(forBase(config), inputsForBase(config, inputs)) ?? [];
          const runtime = await thisManager.load(record);
          const files = (await runtime.buildInputs?.(config, inputs)) ?? [];
          if (!z.array(relativeFile).max(20_000).safeParse(files).success) fail('error.runtimePluginResult');
          for (const file of files) await host.resolveWorkspacePath(file, { internal: true });
          return files;
        },
        invalidate() {
          record.checkedAt = 0;
        },
      };
      const thisManager = this;
      record.wrapper = wrapper;
      return wrapper;
    });
  }
  private compilerProvider(config: ProjectConfig, inputs: ProjectBuildInputs): PackageRecord | undefined {
    const settings = inputs.settings;
    const platform = settings?.platforms?.[config.boardId as keyof NonNullable<typeof settings.platforms>];
    const choose = (language: 'c' | 'cpp') => {
      let choice = settings?.common;
      for (const layer of [platform?.common, platform?.[language]]) {
        if (layer)
          choice =
            layer.family === 'inherit' ? { ...choice, ...layer, family: choice?.family ?? 'inherit' } : layer;
      }
      return choice;
    };
    const choices = [choose('c'), choose('cpp')];
    const pins = choices.filter((choice) => (choice?.family as string) === 'plugin') as {
      family: string;
      pluginId?: string;
    }[];
    if (!pins.length) return undefined;
    if (config.runtime?.forceCompiler !== true) fail('error.runtimePluginForceRequired');
    if (
      pins.length !== choices.length ||
      new Set(pins.map((choice) => choice.pluginId)).size !== 1 ||
      !pins[0].pluginId
    )
      fail('error.runtimePluginCompilerConflict');
    const record = this.record(pins[0].pluginId);
    if (!record.manifest.capabilities.includes('compile')) fail('error.runtimePluginCapability');
    return record;
  }
  private compilerBuildInputs(inputs: ProjectBuildInputs): ProjectBuildInputs {
    return {
      ...inputs,
      settings: inputs.settings ? { ...inputs.settings, common: undefined, platforms: undefined } : undefined,
    };
  }
  async compilerInputs(config: ProjectConfig, inputs: ProjectBuildInputs): Promise<readonly string[]> {
    const record = this.compilerProvider(config, inputs);
    if (!record) return [];
    await this.trusted(record);
    const runtime = await this.load(record);
    const declared = runtime.sourceInputs ?? [];
    const dynamic = (await runtime.buildInputs?.(config, this.compilerBuildInputs(inputs))) ?? [];
    const list = z.array(relativeFile).max(20_000);
    if (!list.safeParse(declared).success || !list.safeParse(dynamic).success)
      fail('error.runtimePluginResult');
    const files = [...new Set([...(record.manifest.sourceInputs ?? []), ...declared, ...dynamic])];
    if (!list.safeParse(files).success) fail('error.runtimePluginResult');
    for (const file of files) await this.host!.resolveWorkspacePath(file, { internal: true });
    return files;
  }
  async build(
    defaultRuntime: PlatformRuntime,
    config: ProjectConfig,
    inputs: ProjectBuildInputs,
  ): Promise<BuildResult> {
    const record = this.compilerProvider(config, inputs);
    if (!record) return defaultRuntime.build(config, inputs);
    await this.trusted(record);
    const runtime = await this.load(record);
    const output = await runtime.build(config, this.compilerBuildInputs(inputs));
    const parsed = buildResultSchema.safeParse(output);
    if (!parsed.success) fail('error.runtimePluginResult');
    for (const artifact of parsed.data.artifacts)
      await this.host!.resolveWorkspacePath(artifact, { internal: true });
    return parsed.data;
  }
  async invokeDebug(id: string, method: string, args: unknown[]): Promise<unknown> {
    if (!debugMethods.has(method) || !Array.isArray(args) || args.length > 8)
      fail('error.runtimePluginCapability');
    const record = this.record(id);
    if (!['extend', 'replace'].includes(record.manifest.debugger.mode)) fail('error.runtimePluginCapability');
    const runtime = await this.load(record, ['state', 'storage'].includes(method));
    const handler = runtime.debugger?.[method];
    if (typeof handler !== 'function') fail('error.runtimePluginCapability');
    return handler.apply(runtime.debugger, args);
  }
  async invokeDevice(id: string, method: string, args: unknown[], confirm?: true): Promise<unknown> {
    const record = this.record(id);
    const declaration = record.manifest.ui.actions?.find((action) => action.id === method);
    if (!declaration || !Array.isArray(args) || args.length > 8) fail('error.runtimePluginCapability');
    if (declaration.confirm && confirm !== true) fail('error.runtimePluginConfirmRequired');
    const runtime = await this.load(record);
    const handler =
      runtime.device && Object.hasOwn(runtime.device, method) ? runtime.device[method] : undefined;
    if (typeof handler !== 'function') fail('error.runtimePluginCapability');
    return handler.apply(runtime.device, args);
  }
  async view(id: string, kind: 'debugger' | 'device'): Promise<string | null> {
    const record = this.record(id);
    await this.trusted(record);
    const relative = kind === 'debugger' ? record.manifest.debugger.view : record.manifest.ui.view;
    if (!relative) return null;
    const file = await this.packageFile(record, relative);
    const stat = await fs.stat(file);
    if (stat.size > 1_000_000) fail('error.runtimePluginSize');
    return fs.readFile(file, 'utf8');
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(
      [...this.packages.values()].map(async (record) => {
        record.unregister();
        await record.instance?.dispose?.();
      }),
    );
    this.packages.clear();
    this.key?.fill(0);
    this.key = undefined;
  }
}
