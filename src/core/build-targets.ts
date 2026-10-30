import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ActiveBuildTarget,
  BuildResult,
  BuildTarget,
  ProjectBuildInputs,
  ProjectConfig,
} from '../shared/contracts';
import type { CreatePlatformRuntimes, PlatformRuntime, RuntimeHost } from '../../extensions/runtime';
import { getBoardAdapter } from '../../extensions/registry';
import { parseConfig, parseProjectBuild } from './config';
import {
  artifactsMatch,
  hashArtifacts,
  loadBuildState,
  saveBuildState,
  type PersistedBuildState,
} from './build-state';
import { readProjectFiles, safeWorkspacePath } from './workspace';
import { withComponentBuildInputs } from './component-build';
import { RuntimePlugins } from './runtime-plugins';
import { captureBuildDebugSymbols } from './build-debug-symbols';
import { analyzeCSourceRules, validateProjectLanguageRules } from '../../extensions/completions/rules';
import { analyzeModuleLanguageRules, withModuleLanguageOverrides } from '../shared/module-languages';

const withoutConnection = (config: ProjectConfig) => ({
  ...config,
  port: '',
  baudRate: 0,
  ...(config.programmer ? { programmer: { ...config.programmer, serialNumber: '', frequencyKhz: 0 } } : {}),
  ...(config.runtime ? { runtime: { ...config.runtime, deviceId: undefined } } : {}),
});
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;
function mergeBuild(...values: ProjectBuildInputs[]): ProjectBuildInputs {
  const result: ProjectBuildInputs = {};
  for (const value of values) {
    const {
      targets: _targets,
      defaultTarget: _default,
      components: _components,
      settings,
      ...fields
    } = value;
    Object.assign(result, fields);
    if (settings) {
      const platforms = { ...result.settings?.platforms };
      for (const [id, settingsForPlatform] of Object.entries(settings.platforms ?? {}))
        platforms[id] = { ...platforms[id], ...settingsForPlatform };
      result.settings = { ...result.settings, ...settings, platforms };
    }
  }
  return result;
}
interface Context {
  target: BuildTarget;
  sourceRoot: string;
  config: ProjectConfig;
  inputs: ProjectBuildInputs;
  namespace: string;
  stateFile: string;
  plugins: RuntimePlugins;
  runtimes: PlatformRuntime[];
  host: RuntimeHost;
  signature: string;
  saved: PersistedBuildState | null;
  failed: boolean;
}
export interface BuildEvidenceRecord {
  root: string;
  buildDirectory: string;
  success: boolean;
  stale: boolean;
  timestamp?: string;
  toolchainRoots?: string[];
}

/** Each named target owns runtime instances, source identity and generated files. */
export class BuildTargets {
  private contexts = new Map<string, Context>();
  private activeId?: string;
  private restoredRoot = '';
  private resolutionErrors = new Map<string, Error>();
  constructor(
    private readonly baseHost: RuntimeHost,
    private readonly plugins: RuntimePlugins,
    private readonly createRuntimes: CreatePlatformRuntimes,
  ) {}

  private async context(
    workspace: string,
    rootConfig: ProjectConfig,
    rootBuild: ProjectBuildInputs,
    target: BuildTarget,
  ) {
    const sourceRoot = target.root === '.' ? workspace : await safeWorkspacePath(workspace, target.root);
    if (!(await fs.stat(sourceRoot)).isDirectory()) throw new Error('error.invalidBuildTarget');
    let child: { config?: Partial<ProjectConfig>; build?: ProjectBuildInputs } = {};
    if (target.root !== '.') {
      const file = await safeWorkspacePath(sourceRoot, 'be');
      const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      if (text.trim()) {
        const { build, ...config } = JSON.parse(text);
        child = { config, build: parseProjectBuild(build) };
      }
    }
    const boardId = target.config?.boardId ?? child.config?.boardId ?? rootConfig.boardId;
    const base = boardId === rootConfig.boardId ? rootConfig : getBoardAdapter(boardId).createConfig();
    const childConfig = child.config?.boardId && child.config.boardId !== boardId ? undefined : child.config;
    const combined = { ...base, ...childConfig, ...target.config };
    const config = parseConfig({
      ...combined,
      toolchain: { ...base.toolchain, ...childConfig?.toolchain, ...target.config?.toolchain },
      runtime: { ...base.runtime, ...childConfig?.runtime, ...target.config?.runtime },
      programmer:
        base.programmer || childConfig?.programmer || target.config?.programmer
          ? { ...base.programmer, ...childConfig?.programmer, ...target.config?.programmer }
          : undefined,
    });
    const inherited =
      target.root === '.' ? rootBuild : { settings: rootBuild.settings, cStandard: rootBuild.cStandard };
    const inputs = mergeBuild(inherited, child.build ?? {}, target.build ?? {});
    const signature = JSON.stringify(
      stable([
        sourceRoot,
        withoutConnection(config),
        inputs,
        (await this.plugins.state()).plugins.map(({ id, fingerprint }) => [id, fingerprint]),
      ]),
    );
    const previous = this.contexts.get(target.id);
    if (previous?.signature === signature) {
      previous.target = target;
      return previous;
    }
    if (previous) {
      await previous.plugins.close();
      this.contexts.delete(target.id);
    }
    const namespace = `.blode/targets/${target.id}`;
    const mapped = (relative: string) =>
      relative.replace(/^\.blode\/(build|staging)(?=\/|$)/, `${namespace}/$1`);
    const host: RuntimeHost = {
      ...this.baseHost,
      projectRoot: () => sourceRoot,
      readProjectFiles: () => readProjectFiles(sourceRoot),
      resolveWorkspacePath: (relative, options) => safeWorkspacePath(sourceRoot, mapped(relative), options),
      async resetDirectory(relative) {
        if (relative !== '.blode/build' && !relative.startsWith('.blode/staging/'))
          throw new Error('error.invalidPath');
        const expected = mapped(relative);
        const directory = await safeWorkspacePath(sourceRoot, expected, { internal: true });
        if (path.relative(sourceRoot, directory).replaceAll('\\', '/') !== expected)
          throw new Error('error.invalidPath');
        await fs.rm(directory, { recursive: true, force: true });
        await fs.mkdir(directory, { recursive: true });
        return directory;
      },
    };
    const builtins = this.createRuntimes(host),
      plugins = this.plugins.fork();
    const stateFile = `${namespace}/build-state.json`;
    const context: Context = {
      target,
      sourceRoot,
      config,
      inputs,
      namespace,
      stateFile,
      plugins,
      runtimes: [...builtins, ...plugins.attach(host, builtins)],
      host,
      signature,
      saved: await loadBuildState(sourceRoot, stateFile),
      failed: false,
    };
    if (context.config.boardId === 'auto') {
      const candidates = (
        await Promise.all(context.runtimes.map((runtime) => runtime.projectConfig?.(context.config, inputs)))
      ).filter((value): value is ProjectConfig => !!value);
      if (candidates.length === 1) context.config = parseConfig(candidates[0]);
    }
    this.contexts.set(target.id, context);
    return context;
  }
  private async configured(workspace: string, config: ProjectConfig, build: ProjectBuildInputs) {
    if (this.restoredRoot !== workspace) {
      await this.clear();
      this.restoredRoot = workspace;
      try {
        const value = JSON.parse(
          await fs.readFile(
            await safeWorkspacePath(workspace, '.blode/active-build-target.json', { internal: true }),
            'utf8',
          ),
        );
        if (typeof value.id === 'string') this.activeId = value.id;
      } catch {}
    }
    const ids = new Set(build.targets?.map((target) => target.id));
    for (const [id, context] of this.contexts)
      if (!ids.has(id)) {
        await context.plugins.close();
        this.contexts.delete(id);
      }
    if (this.activeId && !ids.has(this.activeId)) this.activeId = undefined;
    this.resolutionErrors.clear();
    const resolved = await Promise.all(
      (build.targets ?? []).map(async (target) => {
        try {
          return await this.context(workspace, config, build, target);
        } catch (error) {
          this.resolutionErrors.set(target.id, error instanceof Error ? error : new Error(String(error)));
          return null;
        }
      }),
    );
    return resolved.filter((context): context is Context => !!context);
  }
  private runtime(context: Context) {
    const runtime = context.runtimes.find((runtime) => runtime.id === context.config.boardId);
    if (!runtime) throw new Error('error.selectCompilePlatform');
    return runtime;
  }
  private async fingerprint(context: Context, files?: Awaited<ReturnType<typeof readProjectFiles>>) {
    files ??= await readProjectFiles(context.sourceRoot);
    // The effective descriptor is included once; saved connection changes do not invalidate code.
    const sources = files.filter((file) => file.path !== 'be');
    const hash = createHash('sha256')
      .update('blode-target-v1')
      .update(
        JSON.stringify(
          stable([
            withoutConnection(context.config),
            context.inputs,
            sources,
            (await context.plugins.state()).plugins.map(({ id, fingerprint }) => [id, fingerprint]),
          ]),
        ),
      );
    const runtime = this.runtime(context),
      inputs = await withComponentBuildInputs(context.sourceRoot, context.inputs);
    const extra = [
      ...runtime.sourceInputs,
      ...(runtime.buildInputs ? await runtime.buildInputs(context.config, inputs) : []),
      ...(await context.plugins.compilerInputs(context.config, inputs)),
      ...(inputs.components?.inputs ?? []),
    ];
    for (const relative of [...new Set(extra)].sort()) {
      const data = await fs
        .readFile(await safeWorkspacePath(context.sourceRoot, relative))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
      hash.update(relative).update(data ?? 'missing');
    }
    return hash.digest('hex');
  }
  private async stale(context: Context) {
    if (!context.saved) return context.failed;
    try {
      return (
        context.failed ||
        context.saved.sourceFingerprint !== (await this.fingerprint(context)) ||
        !(await artifactsMatch(context.sourceRoot, context.saved.artifactHashes))
      );
    } catch {
      return true;
    }
  }
  private publicResult(workspace: string, context: Context, result: BuildResult): BuildResult {
    const prefix = path.relative(workspace, context.sourceRoot).replaceAll('\\', '/');
    return {
      ...structuredClone(result),
      artifacts: result.artifacts.map((file) => (prefix ? `${prefix}/${file}` : file)),
    };
  }
  private metadata(context: Context): ActiveBuildTarget {
    return {
      id: context.target.id,
      name: context.target.name,
      root: context.target.root,
      config: structuredClone(context.config),
      buildDirectory: `${context.namespace}/build`,
      stateFile: context.stateFile,
    };
  }
  async snapshot(workspace: string, config: ProjectConfig, build: ProjectBuildInputs) {
    const contexts = await this.configured(workspace, config, build);
    const results = await Promise.all(
      (build.targets ?? []).map(async (target) => {
        const context = contexts.find((context) => context.target.id === target.id);
        return {
          id: target.id,
          result: context?.saved ? this.publicResult(workspace, context, context.saved.result) : null,
          stale: context ? await this.stale(context) : true,
        };
      }),
    );
    const active = contexts.find((context) => context.target.id === this.activeId);
    return {
      targetBuilds: results,
      ...(active
        ? {
            buildTarget: this.metadata(active),
            lastBuild: results.find((result) => result.id === active.target.id)!.result,
            buildStale: results.find((result) => result.id === active.target.id)!.stale,
          }
        : this.activeId
          ? { lastBuild: null, buildStale: true }
          : {}),
    };
  }
  async evidence(
    workspace: string,
    config: ProjectConfig,
    build: ProjectBuildInputs,
  ): Promise<BuildEvidenceRecord[]> {
    return Promise.all(
      (await this.configured(workspace, config, build)).map(async (context) => {
        const directories = new Set<string>();
        const collect = (value: unknown, key = '') => {
          if (typeof value === 'string' && path.isAbsolute(value)) {
            if (['directory', 'packageDirectory', 'armCompilerDirectory', 'stlinkDirectory'].includes(key))
              directories.add(value);
            if (['arduinoCli', 'python'].includes(key)) directories.add(path.dirname(value));
          } else if (value && typeof value === 'object')
            for (const [key, item] of Object.entries(value)) collect(item, key);
        };
        collect(context.config.toolchain);
        collect(context.inputs.settings);
        return {
          root: context.sourceRoot,
          buildDirectory: `${context.namespace}/build`,
          success: context.saved?.result.success === true,
          stale: await this.stale(context),
          timestamp: context.saved?.result.timestamp,
          toolchainRoots: [...directories],
        };
      }),
    );
  }
  async build(workspace: string, config: ProjectConfig, build: ProjectBuildInputs, id?: string) {
    const contexts = await this.configured(workspace, config, build);
    const selected =
      id ?? build.defaultTarget ?? (build.targets?.length === 1 ? build.targets[0].id : undefined);
    const context = contexts.find((context) => context.target.id === selected);
    if (!context)
      throw (
        this.resolutionErrors.get(selected ?? '') ??
        new Error(selected ? 'error.invalidBuildTarget' : 'error.selectBuildTarget')
      );
    this.activeId = context.target.id;
    const pointer = await safeWorkspacePath(workspace, '.blode/active-build-target.json', { internal: true });
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, JSON.stringify({ id: this.activeId }) + '\n', 'utf8');
    context.failed = true;
    if (context.config.boardId === 'auto') {
      const matches = (
        await Promise.all(
          context.runtimes.map((runtime) => runtime.projectConfig?.(context.config, context.inputs)),
        )
      ).filter((value): value is ProjectConfig => !!value);
      if (matches.length !== 1) throw new Error('error.selectCompilePlatform');
      context.config = parseConfig(matches[0]);
    }
    const files = await readProjectFiles(context.sourceRoot),
      before = await this.fingerprint(context, files);
    context.host.emit('status.buildStarted', 'info', 'status');
    const declared = await context.plugins.languages(
      context.config.boardId,
      context.inputs.cStandard ?? 'c17',
    );
    const language =
      declared && withModuleLanguageOverrides(declared, files, context.inputs.cStandard ?? 'c17');
    const diagnostics = language
      ? [...language.diagnostics, ...analyzeModuleLanguageRules(language, files)]
      : [
          ...validateProjectLanguageRules(files, context.inputs.cStandard ?? 'c17'),
          ...analyzeCSourceRules(files, context.inputs.cStandard ?? 'c17'),
        ];
    for (const diagnostic of diagnostics)
      context.host.emit(
        `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity}: ${diagnostic.message}`,
        diagnostic.severity,
      );
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
      throw new Error('error.languageRulesInvalid');
    const inputs = await withComponentBuildInputs(context.sourceRoot, context.inputs);
    const raw = await context.plugins.build(this.runtime(context), context.config, inputs);
    const result = {
      ...raw,
      artifacts: raw.artifacts.map((file) =>
        file.replace(/^\.blode\/(build|staging)(?=\/|$)/, `${context.namespace}/$1`),
      ),
    };
    if (result.success && before === (await this.fingerprint(context))) {
      context.saved = {
        version: 1,
        result,
        sourceFingerprint: before,
        artifactHashes: await hashArtifacts(context.sourceRoot, result.artifacts),
        debugSymbols: await captureBuildDebugSymbols(context.sourceRoot, result, context.config.boardId),
      };
      await saveBuildState(context.sourceRoot, context.saved, context.stateFile);
      context.failed = false;
    } else if (result.success) {
      result.success = false;
      context.host.emit('error.sourceChanged', 'error');
    }
    context.host.emit(
      result.success ? 'status.buildSucceeded' : 'status.buildFailed',
      result.success ? 'success' : 'error',
      'status',
    );
    return this.publicResult(workspace, context, result);
  }
  async flash(workspace: string, config: ProjectConfig, build: ProjectBuildInputs): Promise<boolean> {
    const context = (await this.configured(workspace, config, build)).find(
      (context) => context.target.id === this.activeId,
    );
    if (!context) {
      if (this.activeId)
        throw this.resolutionErrors.get(this.activeId) ?? new Error('error.invalidBuildTarget');
      return false;
    }
    if (!context.saved || (await this.stale(context))) throw new Error('error.buildRequired');
    if (config.boardId !== 'auto' && config.boardId !== context.config.boardId)
      throw new Error('error.targetDeviceMismatch');
    const connected: ProjectConfig = {
      ...context.config,
      port: config.port,
      baudRate: config.baudRate,
      programmer: context.config.programmer
        ? {
            ...context.config.programmer,
            serialNumber: config.programmer?.serialNumber ?? '',
            frequencyKhz: config.programmer?.frequencyKhz ?? context.config.programmer.frequencyKhz,
          }
        : undefined,
      runtime: { ...context.config.runtime, deviceId: config.runtime?.deviceId },
    };
    context.host.emit('status.flashStarted', 'info', 'status');
    await this.runtime(context).flash(connected, context.saved.result);
    context.host.emit('status.flashSucceeded', 'success', 'status');
    return true;
  }
  async clear() {
    await Promise.all([...this.contexts.values()].map((context) => context.plugins.close()));
    this.contexts.clear();
    this.activeId = undefined;
    this.restoredRoot = '';
  }
  async useDefault(workspace: string) {
    this.activeId = undefined;
    await fs
      .unlink(await safeWorkspacePath(workspace, '.blode/active-build-target.json', { internal: true }))
      .catch(() => {});
  }
}
