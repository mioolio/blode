import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldControl } from 'node:timers/promises';
import type { AppState, ProjectConfig } from '../shared/contracts';
import type {
  LanguageExternalSource,
  LanguageNavigationRequest,
  LanguageSource,
  SourceLocation,
} from '../shared/language';
import { WorkspaceLanguageIndex } from '../shared/language-index';
import { getCompilerIncludeRoots } from './compiler-includes';
import { safeWorkspacePath } from './workspace';
import type { BuildEvidenceStatus } from './build-dependencies';
import { NavigationIo, boundedNavigationMap as bounded } from './language-navigation-work';

const sourcePattern = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inc|ipp|ino)$/i;
const slash = (value: string) => value.replaceAll('\\', '/');
const cancelled = () => new Error('error.operationCancelled');
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
};
const signature = (stat: { mtimeMs: number; ctimeMs: number; size: number }) =>
  `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
/** Cancel one consumer without cancelling the work another consumer still needs. */
function waiting<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
interface ExternalRecord {
  id: string;
  file: string;
  path: string;
  content: string;
  signature: string;
}
interface Query {
  consumers: Set<AbortSignal>;
  promise: Promise<SourceLocation[]>;
}
interface Snapshot {
  root: string;
  key: string;
  configKey: string;
  roots: string[];
  controller: AbortController;
  index: WorkspaceLanguageIndex;
  sources: Map<string, LanguageSource>;
  external: Map<string, ExternalRecord>;
  externalPaths: Map<string, ExternalRecord>;
  issuing: Map<string, Promise<SourceLocation | undefined>>;
  resolved: Map<string, Promise<SourceLocation[]>>;
  rootMatches: Map<string, Promise<string[]>>;
  directories: Map<string, Promise<Set<string>>>;
  queue: { path: string; specifier: string; depth: number }[];
  queued: Set<string>;
  cursor: number;
  scanning?: Promise<void>;
  referencing?: Promise<SourceLocation[]>;
  consumers: number;
  revision: number;
  queries: Map<string, Query>;
  results: Map<string, { result: SourceLocation[]; expires: number }>;
  bytes: number;
  complete: boolean;
}
/** Compiler headers are read-only capabilities, scoped to the expected workspace. */
export class LanguageNavigationService {
  private io = new NavigationIo();
  private cached?: { time: number; snapshot: Snapshot };
  private pending?: {
    key: string;
    promise: Promise<Snapshot>;
    controller: AbortController;
    consumers: number;
    settled: boolean;
  };
  private requests = new Map<string, { root: string; controller: AbortController }>();
  private cancelledRequests = new Map<string, number>();
  constructor(
    private readonly options: {
      core: {
        workspaceSnapshot(): Promise<Pick<AppState, 'projectRoot' | 'files'>>;
        currentConfig(): ProjectConfig;
        currentProjectRoot(): string;
        buildEvidenceState?(): Promise<BuildEvidenceStatus>;
      };
      toolchainRoot: string;
      env?: NodeJS.ProcessEnv;
      /** Injectable filesystem metadata lifetime for invalidation tests. */
      refreshMs?: number;
    },
  ) {}
  readonlyPaths(expectedProjectRoot: string): readonly string[] {
    if (
      path.resolve(expectedProjectRoot) !== path.resolve(this.options.core.currentProjectRoot()) ||
      this.cached?.snapshot.root !== expectedProjectRoot
    )
      return [];
    return [...this.cached.snapshot.external.values()].map((source) => source.path);
  }
  private requireRoot(expected: string) {
    if (!expected || path.resolve(expected) !== path.resolve(this.options.core.currentProjectRoot()))
      throw new Error('error.collaborationProjectChanged');
  }
  private check(state: Snapshot) {
    this.requireRoot(state.root);
    if (
      state.controller.signal.aborted ||
      state.configKey !== JSON.stringify(this.options.core.currentConfig())
    )
      throw cancelled();
  }
  private enqueue(state: Snapshot, source: LanguageSource, depth: number) {
    if (depth >= 12) return;
    for (const include of state.index.includesForPath(source.path)) {
      const key = include.path + '\0' + include.specifier;
      if (state.queued.has(key)) continue;
      state.queued.add(key);
      state.queue.push({ path: include.path, specifier: include.specifier, depth });
    }
  }
  private async upsert(state: Snapshot, source: LanguageSource, depth: number) {
    this.check(state);
    state.sources.set(source.path, source);
    state.index.upsert([source]);
    state.results.clear();
    this.enqueue(state, source, depth);
    await yieldControl();
    this.check(state);
  }
  private async state(expected: string, signal: AbortSignal): Promise<Snapshot> {
    this.requireRoot(expected);
    const workspace = await waiting(this.options.core.workspaceSnapshot(), signal),
      config = this.options.core.currentConfig(),
      configKey = JSON.stringify(config);
    if (path.resolve(workspace.projectRoot) !== path.resolve(expected))
      throw new Error('error.collaborationProjectChanged');
    const hash = createHash('sha256').update(workspace.projectRoot).update(configKey);
    let bytes = 0;
    for (const file of workspace.files) {
      hash.update(file.path).update('\0').update(file.content).update('\0');
      bytes += file.content.length;
      if (bytes > 128_000) {
        await yieldControl();
        if (signal.aborted) throw cancelled();
        bytes = 0;
      }
    }
    const key = hash.digest('hex');
    if (
      this.cached?.snapshot.key === key &&
      !this.cached.snapshot.controller.signal.aborted &&
      Date.now() - this.cached.time < (this.options.refreshMs ?? 2000)
    )
      return this.cached.snapshot;
    if (this.pending?.key !== key || this.pending.controller.signal.aborted) {
      this.pending?.controller.abort();
      const previous = this.cached?.snapshot;
      if (previous?.key !== key) previous?.controller.abort();
      const controller = new AbortController();
      const entry = {
        key,
        controller,
        consumers: 0,
        settled: false,
        promise: undefined as unknown as Promise<Snapshot>,
      };
      const assertCurrent = () => {
        this.requireRoot(expected);
        if (controller.signal.aborted || configKey !== JSON.stringify(this.options.core.currentConfig()))
          throw cancelled();
      };
      entry.promise = (async () => {
        const roots = await getCompilerIncludeRoots({
          workspace,
          config,
          toolchainRoot: this.options.toolchainRoot,
          env: this.options.env,
          buildEvidence: await this.options.core.buildEvidenceState?.().catch(() => undefined),
          signal: controller.signal,
        });
        assertCurrent();
        let state: Snapshot;
        if (
          previous?.key === key &&
          !previous.controller.signal.aborted &&
          JSON.stringify(previous.roots) === JSON.stringify(roots)
        ) {
          await previous.scanning?.catch(() => undefined);
          assertCurrent();
          state = previous;
          state.revision++;
          state.results.clear();
          state.queries.clear();
          state.directories.clear();
          state.rootMatches.clear();
          state.resolved.clear();
          await bounded([...state.external.values()], async (record) => {
            assertCurrent();
            const stat = await fs.lstat(record.file).catch(() => undefined);
            if (stat?.isFile() && !stat.isSymbolicLink() && signature(stat) === record.signature) return;
            const read = await this.read(state, record.file);
            assertCurrent();
            if (read) {
              state.bytes += Buffer.byteLength(read.content) - Buffer.byteLength(record.content);
              record.content = read.content;
              record.signature = read.signature;
              await this.upsert(state, { path: record.path, content: read.content }, 0);
            } else {
              state.bytes -= Buffer.byteLength(record.content);
              state.external.delete(record.id);
              state.externalPaths.delete(record.path);
              state.sources.delete(record.path);
              state.index.upsert([{ path: record.path, content: '' }]);
            }
          });
          state.queue = [];
          state.queued.clear();
          state.cursor = 0;
          state.complete = false;
          for (const source of state.sources.values()) this.enqueue(state, source, 0);
        } else {
          previous?.controller.abort();
          state = {
            root: expected,
            key,
            configKey,
            roots,
            controller,
            index: new WorkspaceLanguageIndex(),
            sources: new Map(),
            external: new Map(),
            externalPaths: new Map(),
            issuing: new Map(),
            resolved: new Map(),
            rootMatches: new Map(),
            directories: new Map(),
            queue: [],
            queued: new Set(),
            cursor: 0,
            consumers: 0,
            revision: 0,
            queries: new Map(),
            results: new Map(),
            bytes: 0,
            complete: false,
          };
          for (const file of workspace.files) {
            assertCurrent();
            await this.upsert(state, { path: file.path, content: file.content }, 0);
          }
          if (previous?.root === expected)
            for (const record of previous.external.values()) {
              assertCurrent();
              await this.issue(state, record.file, 0);
            }
        }
        assertCurrent();
        this.cached = { time: Date.now(), snapshot: state };
        return state;
      })().finally(() => {
        entry.settled = true;
        if (this.pending === entry) this.pending = undefined;
      });
      this.pending = entry;
    }
    const pending = this.pending!;
    pending.consumers++;
    try {
      return await waiting(pending.promise, signal);
    } finally {
      if (--pending.consumers === 0 && !pending.settled) pending.controller.abort();
    }
  }
  private read(state: Snapshot, file: string): Promise<{ content: string; signature: string } | undefined> {
    return this.io.run(() => this.readFile(state, file));
  }
  private async readFile(
    state: Snapshot,
    file: string,
  ): Promise<{ content: string; signature: string } | undefined> {
    this.check(state);
    const root = state.roots.find((directory) => inside(directory, file));
    if (!root || !sourcePattern.test(file)) return;
    // Reject junctions at every child component of the discovered include root.
    let cursor = root;
    for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch(() => null);
      if (!stat || stat.isSymbolicLink()) return;
      this.check(state);
    }
    const handle = await fs.open(file, 'r').catch(() => undefined);
    if (!handle) return;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1_000_000) return;
      const buffer = Buffer.alloc(Math.min(stat.size + 1, 1_000_001));
      let size = 0;
      while (size < buffer.length) {
        this.check(state);
        const result = await handle.read(buffer, size, buffer.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > 1_000_000 || buffer.subarray(0, size).includes(0)) return;
      return { content: buffer.subarray(0, size).toString('utf8'), signature: signature(stat) };
    } finally {
      await handle.close();
    }
  }
  private async issue(state: Snapshot, file: string, depth: number): Promise<SourceLocation | undefined> {
    const pending = state.issuing.get(file);
    if (pending) return pending;
    const promise = this.issueFile(state, file, depth);
    state.issuing.set(file, promise);
    try {
      return await promise;
    } finally {
      if (state.issuing.get(file) === promise) state.issuing.delete(file);
    }
  }
  private async issueFile(state: Snapshot, file: string, depth: number): Promise<SourceLocation | undefined> {
    this.check(state);
    if (inside(state.root, file)) {
      const relative = slash(path.relative(state.root, file));
      try {
        await safeWorkspacePath(state.root, relative);
      } catch {
        return;
      }
      if (state.index.source(relative) === undefined) {
        const read = await this.read(state, file);
        if (!read) return;
        await this.upsert(state, { path: relative, content: read.content }, depth);
      }
      return { path: relative, line: 1, column: 1, endLine: 1, endColumn: 1 };
    }
    const id = createHash('sha256').update(state.root).update('\0').update(file).digest('hex').slice(0, 32);
    let record = state.external.get(id);
    if (!record) {
      if (state.external.size >= 512 || state.bytes >= 12_000_000) return;
      const read = await this.read(state, file);
      if (!read) return;
      this.check(state);
      if (state.external.size >= 512 || state.bytes >= 12_000_000) return;
      const virtual = `@external/${id}/${path.basename(file)}`;
      record = { id, file, path: virtual, ...read };
      state.bytes += Buffer.byteLength(read.content);
      state.external.set(id, record);
      state.externalPaths.set(virtual, record);
      await this.upsert(state, { path: virtual, content: read.content }, depth);
    }
    return { path: record.path, externalId: id, line: 1, column: 1, endLine: 1, endColumn: 1 };
  }
  private origin(state: Snapshot, request: Pick<LanguageNavigationRequest, 'path' | 'externalId'>): string {
    if (request.externalId) {
      const record = state.external.get(request.externalId);
      if (!record || record.path !== request.path) throw new Error('error.languageSourceExpired');
      return record.file;
    }
    if (path.isAbsolute(request.path) || request.path.startsWith('@external/'))
      throw new Error('error.invalidPath');
    const resolved = path.resolve(state.root, request.path);
    if (!inside(state.root, resolved)) throw new Error('error.invalidPath');
    return resolved;
  }
  private async exists(state: Snapshot, file: string): Promise<boolean> {
    this.check(state);
    if (!state.consumers) throw cancelled();
    const directory = path.dirname(file);
    if (!state.directories.has(directory))
      state.directories.set(
        directory,
        this.io
          .run(async () => {
            this.check(state);
            return fs.readdir(directory, { withFileTypes: true });
          })
          .then(
            (entries) =>
              new Set(
                entries.filter((item) => item.isFile() && !item.isSymbolicLink()).map((item) => item.name),
              ),
          )
          .catch(() => new Set()),
      );
    const entries = state.directories.get(directory)!;
    while (state.directories.size > 8192) state.directories.delete(state.directories.keys().next().value!);
    return (await entries).has(path.basename(file));
  }
  private async includes(
    state: Snapshot,
    from: string,
    specifier: string,
    depth: number,
  ): Promise<SourceLocation[]> {
    if (
      !specifier ||
      path.isAbsolute(specifier) ||
      path.win32.isAbsolute(specifier) ||
      /[\0\r\n<>"|?*]/.test(specifier)
    )
      return [];
    const key = from + '\0' + specifier;
    const existing = state.resolved.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const spec = specifier.replaceAll('\\', path.sep);
      if (!sourcePattern.test(spec)) return [];
      // Resolve shared SDK tokens once, retaining relative-header lookup per originating file.
      if (!state.rootMatches.has(spec))
        state.rootMatches.set(
          spec,
          (async () => {
            const candidates = [
              ...new Set(
                state.roots.flatMap((root) => {
                  const file = path.resolve(root, spec);
                  return inside(root, file) ? [file] : [];
                }),
              ),
            ];
            const present = await bounded(candidates, (file) => this.exists(state, file));
            this.check(state);
            return candidates.filter((_file, index) => present[index]);
          })(),
        );
      const matches = state.rootMatches.get(spec)!;
      void matches.catch(() => {
        if (state.rootMatches.get(spec) === matches) state.rootMatches.delete(spec);
      });
      while (state.rootMatches.size > 4096) state.rootMatches.delete(state.rootMatches.keys().next().value!);
      const local = path.resolve(path.dirname(from), spec);
      const localExists =
        state.roots.some((root) => inside(root, local)) && (await this.exists(state, local));
      const candidates = [...new Set([...(localExists ? [local] : []), ...(await matches)])];
      const found: SourceLocation[] = [];
      for (const file of candidates) {
        this.check(state);
        if (!state.consumers) throw cancelled();
        const location = await this.issue(state, file, depth + 1);
        if (location) found.push(location);
        if (found.length >= 32) break;
      }
      return found;
    })();
    state.resolved.set(key, promise);
    while (state.resolved.size > 8192) state.resolved.delete(state.resolved.keys().next().value!);
    try {
      return await promise;
    } catch (error) {
      if (state.resolved.get(key) === promise) state.resolved.delete(key);
      throw error;
    }
  }
  private async scanBatch(state: Snapshot): Promise<void> {
    if (state.scanning) return state.scanning;
    const promise = (async () => {
      this.check(state);
      if (!state.consumers) throw cancelled();
      for (const include of state.queue.slice(state.cursor, state.cursor + 4)) {
        this.check(state);
        if (!state.consumers) throw cancelled();
        const from = state.externalPaths.get(include.path)?.file ?? path.resolve(state.root, include.path);
        await this.includes(state, from, include.specifier, include.depth);
        state.cursor++;
        await yieldControl();
      }
      state.complete =
        state.cursor >= state.queue.length || state.external.size >= 512 || state.bytes >= 12_000_000;
    })();
    state.scanning = promise;
    try {
      await promise;
    } finally {
      if (state.scanning === promise) state.scanning = undefined;
    }
  }
  private location(state: Snapshot, location: SourceLocation): SourceLocation {
    const externalId = location.path.startsWith('@external/') ? location.path.split('/')[1] : undefined;
    return externalId && state.external.has(externalId) ? { ...location, externalId } : location;
  }
  private async query(
    state: Snapshot,
    request: LanguageNavigationRequest,
    signal: AbortSignal,
  ): Promise<SourceLocation[]> {
    const from = this.origin(state, request),
      key = JSON.stringify([
        request.kind,
        request.path,
        request.externalId,
        request.symbol,
        request.specifier,
      ]);
    const cached = state.results.get(key);
    if (cached && cached.expires > Date.now()) {
      state.results.delete(key);
      state.results.set(key, cached);
      return cached.result.map((location) => ({ ...location }));
    }
    let job = state.queries.get(key);
    if (job && ![...job.consumers].some((signal) => !signal.aborted)) job = undefined;
    if (!job) {
      if (state.queries.size >= 32) throw cancelled();
      const consumers = new Set<AbortSignal>(),
        revision = state.revision;
      const check = () => {
        this.check(state);
        if (revision !== state.revision || ![...consumers].some((signal) => !signal.aborted))
          throw cancelled();
      };
      job = { consumers, promise: undefined as unknown as Promise<SourceLocation[]> };
      const created = job;
      job.promise = Promise.resolve()
        .then(async () => {
          check();
          let result: SourceLocation[];
          if (request.kind === 'include')
            result = await this.includes(state, from, request.specifier ?? '', 0);
          else {
            const found = () =>
              state.index
                .definitions(request.symbol ?? '', request.path, request.kind === 'declaration')
                .some((symbol) => symbol.definition === (request.kind !== 'declaration'));
            while (!state.complete && (request.kind === 'reference' || !found())) {
              check();
              try {
                await this.scanBatch(state);
              } catch (error) {
                // A previous last consumer can cancel a batch just before this consumer joins it.
                if (!(error instanceof Error) || error.message !== 'error.operationCancelled') throw error;
                check();
              }
            }
            check();
            if (request.kind === 'reference') {
              while (state.referencing) {
                await state.referencing.catch(() => undefined);
                check();
              }
              const references = state.index.referencesAsync(request.symbol ?? '', {
                cancelled: () =>
                  revision !== state.revision ||
                  state.controller.signal.aborted ||
                  ![...consumers].some((signal) => !signal.aborted),
                yieldControl: async () => {
                  await yieldControl();
                  this.check(state);
                },
              });
              state.referencing = references;
              try {
                result = await references;
              } finally {
                if (state.referencing === references) state.referencing = undefined;
              }
            } else
              result = state.index.definitions(
                request.symbol ?? '',
                request.path,
                request.kind === 'declaration',
              );
            result = result.slice(0, 1000).map((location) => this.location(state, location));
          }
          check();
          state.results.delete(key);
          state.results.set(key, { result, expires: result.length ? Infinity : Date.now() + 1500 });
          while (state.results.size > 256) state.results.delete(state.results.keys().next().value!);
          return result;
        })
        .finally(() => {
          if (state.queries.get(key) === created) state.queries.delete(key);
        });
      state.queries.set(key, job);
    }
    job.consumers.add(signal);
    state.consumers++;
    try {
      return (await waiting(job.promise, signal)).map((location) => ({ ...location }));
    } finally {
      job.consumers.delete(signal);
      state.consumers--;
    }
  }
  async navigate(request: LanguageNavigationRequest): Promise<SourceLocation[]> {
    const controller = new AbortController(),
      requestKey = request.expectedProjectRoot + '\0' + request.requestId;
    if (request.requestId) {
      if ((this.cancelledRequests.get(requestKey) ?? 0) > Date.now()) controller.abort();
      this.requests.get(request.requestId)?.controller.abort();
      this.requests.set(request.requestId, { root: request.expectedProjectRoot, controller });
      while (this.requests.size > 256) {
        const oldest = this.requests.keys().next().value!;
        this.requests.get(oldest)?.controller.abort();
        this.requests.delete(oldest);
      }
    }
    try {
      const state = await this.state(request.expectedProjectRoot, controller.signal);
      this.check(state);
      return await this.query(state, request, controller.signal);
    } finally {
      if (request.requestId && this.requests.get(request.requestId)?.controller === controller)
        this.requests.delete(request.requestId);
    }
  }
  async cancel(request: { expectedProjectRoot: string; requestId: string }): Promise<void> {
    const active = this.requests.get(request.requestId);
    if (active?.root === request.expectedProjectRoot) active.controller.abort();
    else {
      this.cancelledRequests.set(request.expectedProjectRoot + '\0' + request.requestId, Date.now() + 10_000);
      while (this.cancelledRequests.size > 256)
        this.cancelledRequests.delete(this.cancelledRequests.keys().next().value!);
    }
  }
  dispose(): void {
    this.cached?.snapshot.controller.abort();
    this.pending?.controller.abort();
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.cancelledRequests.clear();
  }
  async openExternal(request: {
    expectedProjectRoot: string;
    externalId: string;
  }): Promise<LanguageExternalSource> {
    this.requireRoot(request.expectedProjectRoot);
    const state = this.cached?.snapshot,
      record =
        state?.root === request.expectedProjectRoot ? state.external.get(request.externalId) : undefined;
    if (!record || !state) throw new Error('error.languageSourceExpired');
    const read = await this.read(state, record.file);
    if (!read) throw new Error('error.languageSourceUnavailable');
    this.requireRoot(request.expectedProjectRoot);
    if (record.content !== read.content) {
      state.bytes += Buffer.byteLength(read.content) - Buffer.byteLength(record.content);
      record.content = read.content;
      record.signature = read.signature;
      state.revision++;
      state.results.clear();
      state.complete = false;
      state.resolved.clear();
      state.queued.clear();
      state.queue = [];
      state.cursor = 0;
      await this.upsert(state, { path: record.path, content: read.content }, 0);
      for (const source of state.sources.values()) this.enqueue(state, source, 0);
    }
    return {
      id: record.id,
      path: record.path,
      name: path.basename(record.file),
      displayPath: record.file,
      content: read.content,
      language: 'cpp',
      readonly: true,
    };
  }
}
