import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import * as z from 'zod';
import type { RuntimeHost } from '../../extensions/runtime';
import type { InstallationProgress, ProjectConfig, ProjectBuildInputs } from '../shared/contracts';
import type { CompilerChoice } from '../shared/build-settings';
import type {
  ComponentLibrary,
  ManagedComponentLibrary,
  ComponentManifest,
  ComponentLibrariesState,
  ComponentProvidedLibrary,
  ComponentSearchResult,
  ComponentInstallRequest,
  ComponentRemoveRequest,
} from '../shared/components';
import { readComponentZip } from './component-zip';
import {
  compareComponentVersions,
  componentVersionMatches,
  parseComponentDependencies,
  dependencyLabel,
  resolveComponentDependencies,
  type ComponentDependency,
  type DependencyRelease,
} from './component-dependencies';

export const COMPONENT_MANIFEST_FILE = 'blode.components.json';
export const ARDUINO_LIBRARY_INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json.gz';
const MAX_FILE = 64 * 1024 * 1024,
  MAX_TOTAL = 256 * 1024 * 1024,
  MAX_MANIFEST = 8 * 1024 * 1024,
  MAX_FILES = 10000;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const keyOf = (value: string) => value.toLowerCase();
async function renameWithRetry(source: string, destination: string, validate: () => Promise<void>) {
  const delays = [40, 100, 200, 300];
  for (let attempt = 0; ; attempt++) {
    await validate();
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        attempt >= delays.length ||
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
const skipped = new Set([
  '.git',
  '.svn',
  '.hg',
  '.blode',
  '.tools',
  'node_modules',
  '.DS_Store',
  '__MACOSX',
  'model-credentials',
]);
const excludedSources = /(?:^|\/)(?:examples?|tests?|extras|docs?|build|dist)(?:\/|$)/i;
const sourceExtension = /\.(?:c|cc|cpp|cxx|s)$/i;
const headerExtension = /\.(?:h|hh|hpp|hxx)$/i;
const safeRelative = (value: string) =>
  !!value &&
  value.length <= 4096 &&
  !value
    .split('/')
    .some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[\\<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
const relativeSchema = z.string().refine(safeRelative);
export const safeComponentRelativePath = safeRelative;
const componentPath = z
  .string()
  .regex(/^(?:libraries|components)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/)
  .refine(safeRelative);
export const componentManifestSchema = z
  .object({
    version: z.literal(1),
    components: z
      .array(
        z
          .object({
            id: z.string().regex(/^component-[a-f0-9]{16}$/),
            name: z.string().min(1).max(128),
            version: z.string().min(1).max(64).optional(),
            kind: z.enum(['arduino', 'c']),
            path: componentPath,
            source: z
              .object({
                type: z.enum(['directory', 'archive', 'arduino']),
                url: z.string().url().max(2048).optional(),
              })
              .strict(),
            includes: z.array(relativeSchema).max(MAX_FILES),
            sources: z.array(relativeSchema).max(MAX_FILES),
            dependencies: z.array(z.string().max(512)).max(128),
            integrity: z.record(relativeSchema, z.string().regex(/^[a-f0-9]{64}$/)),
          })
          .strict()
          .superRefine((component, context) => {
            const prefix = component.path + '/';
            if ((component.kind === 'arduino') !== component.path.startsWith('libraries/'))
              context.addIssue({ code: 'custom', message: 'Component kind/path mismatch' });
            if (
              [...component.includes, ...component.sources].some(
                (file) => file !== component.path && !file.startsWith(prefix),
              )
            )
              context.addIssue({ code: 'custom', message: 'Build inputs must stay within the component' });
            if (Object.keys(component.integrity).length > MAX_FILES)
              context.addIssue({ code: 'custom', message: 'Too many component files' });
          }),
      )
      .max(128),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const field of ['id', 'name', 'path'] as const)
      if (
        new Set(manifest.components.map((component) => keyOf(component[field]))).size !==
        manifest.components.length
      )
        context.addIssue({ code: 'custom', message: `Duplicate component ${field}` });
  });

async function manifestSnapshot(
  projectRoot: string,
): Promise<{ manifest: ComponentManifest; text: string | null }> {
  const file = path.join(projectRoot, COMPONENT_MANIFEST_FILE);
  const info = await fs.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { manifest: { version: 1, components: [] }, text: null };
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST)
    throw new Error('error.componentManifest');
  try {
    const text = await fs.readFile(file, 'utf8');
    return { manifest: componentManifestSchema.parse(JSON.parse(text)) as ComponentManifest, text };
  } catch {
    throw new Error('error.componentManifest');
  }
}
export async function readComponentManifest(projectRoot: string): Promise<ComponentManifest> {
  return (await manifestSnapshot(projectRoot)).manifest;
}

export interface ComponentOperationHooks {
  progress?: (progress: InstallationProgress) => void;
  log?: (line: string) => void;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}
interface Options {
  projectRoot: () => string;
  dataRoot: string;
  toolchainRoot?: string;
  config: () => ProjectConfig | Promise<ProjectConfig>;
  build?: () => ProjectBuildInputs | Promise<ProjectBuildInputs>;
  runner?: RuntimeHost['runCommand'];
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}
interface Release extends DependencyRelease {
  url: string;
  size: number;
  checksum: string;
  author?: string;
  description?: string;
  website?: string;
}
interface Payload {
  library: ManagedComponentLibrary;
  files: Map<string, Buffer>;
  directories?: string[];
}
function properties(bytes: Buffer | undefined): Record<string, string> {
  if (!bytes) return {};
  if (bytes.length > 256000) throw new Error('error.componentManifest');
  const result: Record<string, string> = Object.create(null);
  for (const line of bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    if (Object.hasOwn(result, name)) throw new Error('error.componentManifest');
    result[name] = line.slice(separator + 1).trim();
  }
  return result;
}
function slug(name: string) {
  const value =
    name
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 63) || `Library_${hash(name).slice(0, 12)}`;
  return safeRelative(value) ? value : `Library_${hash(name).slice(0, 12)}`;
}
function unwrap(files: Map<string, Buffer>): Map<string, Buffer> {
  const filtered = [...files].filter(([file]) => !file.split('/').some((part) => skipped.has(part)));
  const first = filtered[0]?.[0].split('/')[0];
  const prefix = first && filtered.every(([file]) => file.startsWith(first + '/')) ? first + '/' : '';
  return new Map(filtered.map(([file, bytes]) => [prefix ? file.slice(prefix.length) : file, bytes]));
}
function payload(files: Map<string, Buffer>, fallback: string, source: ComponentLibrary['source']): Payload {
  const props = properties(files.get('library.properties'));
  const arduino = files.has('library.properties');
  const name = (props.name || fallback).trim();
  if (!name || name.length > 128 || /[\x00-\x1f]/.test(name)) throw new Error('error.componentNotLibrary');
  if (arduino && (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(name) || !props.version))
    throw new Error('error.componentManifest');
  if (props.version) compareComponentVersions(props.version, props.version);
  const kind = arduino ? 'arduino' : 'c';
  const componentDirectory = `${arduino ? 'libraries' : 'components'}/${slug(name)}`;
  const modern = arduino && [...files.keys()].some((file) => file.startsWith('src/'));
  const relevant = [...files.keys()].filter((file) => {
    if (arduino)
      return modern ? file.startsWith('src/') : !file.includes('/') || /^utility\/[^/]+$/.test(file);
    return !excludedSources.test(file);
  });
  const sources = relevant.filter((file) => sourceExtension.test(file));
  const headers = relevant.filter((file) => headerExtension.test(file));
  if (!sources.length && !headers.length) throw new Error('error.componentNotLibrary');
  const includes = arduino
    ? modern
      ? ['src']
      : ['', ...(relevant.some((file) => file.startsWith('utility/')) ? ['utility'] : [])]
    : [
        '',
        ...new Set(
          headers
            .map((file) => path.posix.dirname(file))
            .map((directory) => (directory === '.' ? '' : directory)),
        ),
      ];
  return {
    files,
    library: {
      id: `component-${hash(`${kind}:${name.toLowerCase()}`).slice(0, 16)}`,
      name,
      kind,
      ...(props.version ? { version: props.version } : {}),
      path: componentDirectory,
      source,
      includes: [
        ...new Set(includes.map((directory) => componentDirectory + (directory ? '/' + directory : ''))),
      ],
      sources: sources.map((file) => `${componentDirectory}/${file}`),
      dependencies: parseComponentDependencies(props.depends ?? '').map(dependencyLabel),
      integrity: Object.fromEntries([...files].map(([file, bytes]) => [file, hash(bytes)])),
    },
  };
}
export async function readComponentDirectory(
  directory: string,
  includeIgnored = false,
): Promise<Map<string, Buffer>> {
  const root = await fs.realpath(directory);
  const original = await fs.lstat(directory);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error('error.componentPath');
  const files = new Map<string, Buffer>(),
    names = new Set<string>();
  let total = 0;
  async function visit(current: string, depth: number) {
    if (depth > 32) throw new Error('error.componentTooLarge');
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (
        !includeIgnored &&
        (skipped.has(entry.name) ||
          /^(?:\.env(?:\.|$)|model-service\.json$|.*\.credential$)/i.test(entry.name))
      )
        continue;
      const full = path.join(current, entry.name);
      const relative = slash(path.relative(root, full));
      if (
        !safeRelative(relative) ||
        !within(root, full) ||
        entry.isSymbolicLink() ||
        names.has(relative.toLowerCase())
      )
        throw new Error('error.componentPath');
      names.add(relative.toLowerCase());
      if (names.size > MAX_FILES) throw new Error('error.componentTooLarge');
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error('error.componentPath');
      const stat = await fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE || (total += stat.size) > MAX_TOTAL)
        throw new Error('error.componentTooLarge');
      const bytes = await fs.readFile(full);
      const after = await fs.lstat(full);
      if (
        bytes.length !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        !after.isFile() ||
        after.isSymbolicLink()
      )
        throw new Error('error.componentChanged');
      files.set(relative, bytes);
    }
  }
  await visit(root, 0);
  return files;
}

/** Project-owned component sources; importing never runs library scripts or modifies global libraries. */
export class ComponentLibraries {
  private mutating = false;
  private catalog?: { time: number; entries: Map<string, Release[]> };
  private catalogPending?: Promise<Map<string, Release[]>>;
  constructor(private readonly options: Options) {}
  private abort(hooks: ComponentOperationHooks = {}) {
    if (this.options.signal?.aborted || hooks.signal?.aborted) throw new Error('error.operationCancelled');
  }
  private async root(expected?: string): Promise<string> {
    const current = this.options.projectRoot();
    if (!current) throw new Error('error.noWorkspace');
    const root = await fs.realpath(current);
    if (expected !== undefined && (!expected || (await fs.realpath(expected).catch(() => '')) !== root))
      throw new Error('error.componentProjectChanged');
    return root;
  }
  private async sameProject(root: string) {
    if ((await this.root().catch(() => '')) !== root) throw new Error('error.componentProjectChanged');
  }
  private async state(
    root: string,
    manifest = readComponentManifest(root),
  ): Promise<ComponentLibrariesState> {
    return {
      projectRoot: root,
      manifestPath: COMPONENT_MANIFEST_FILE,
      components: (await manifest).components.map(({ integrity: _, ...library }) => library),
      provided: await this.provided(),
    };
  }
  async list(): Promise<ComponentLibrariesState> {
    if (!this.options.projectRoot())
      return { projectRoot: '', manifestPath: COMPONENT_MANIFEST_FILE, components: [], provided: [] };
    return this.state(await this.root());
  }
  private async provided(): Promise<ComponentProvidedLibrary[]> {
    const config = await this.options.config();
    const settings = (await this.options.build?.())?.settings;
    const platform = settings?.platforms?.[config.boardId];
    let choice: CompilerChoice = { family: 'inherit' };
    for (const layer of [settings?.common, platform?.common, platform?.cpp]) {
      if (!layer) continue;
      choice = layer.family === 'inherit' ? { ...choice, ...layer, family: choice.family } : { ...layer };
    }
    if (!['inherit', 'auto', 'arduino'].includes(choice.family)) return [];
    const fqbn = config.toolchain.fqbn?.split(':');
    if (!fqbn || fqbn.length < 2 || !fqbn.slice(0, 2).every((value) => /^[A-Za-z0-9_-]+$/.test(value)))
      return [];
    const tools = this.options.toolchainRoot || path.join(this.options.dataRoot, 'toolchains');
    let store =
      choice.packageDirectory ||
      (choice.family === 'auto' ? tools : config.toolchain.packageDirectory || tools);
    if (choice.version) {
      try {
        compareComponentVersions(choice.version, choice.version);
      } catch {
        return [];
      }
      const candidates = choice.packageDirectory
        ? [choice.packageDirectory]
        : [path.join(tools, 'versions', `arduino-${fqbn[1]}`, choice.version), store, tools];
      const found: string[] = [];
      for (const candidate of new Set(candidates)) {
        const info = await fs
          .lstat(path.join(candidate, 'arduino-data/packages', fqbn[0], 'hardware', fqbn[1], choice.version))
          .catch(() => null);
        if (info?.isDirectory() && !info.isSymbolicLink()) found.push(candidate);
      }
      if (!found.length) return [];
      store = found[0];
    }
    const hardware = path.join(store, 'arduino-data', 'packages', fqbn[0], 'hardware', fqbn[1]);
    const versions = (await fs.readdir(hardware).catch(() => [] as string[]))
      .filter((value) => /^\d+(?:\.\d+){1,2}(?:[-+][\w.-]+)?$/.test(value))
      .sort((a, b) => compareComponentVersions(b, a));
    const version = choice.version ?? versions[0];
    if (!version) return [];
    const root = path.join(hardware, version, 'libraries');
    const found: ComponentProvidedLibrary[] = [];
    for (const entry of (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).slice(0, 256)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(root, entry.name),
        file = path.join(directory, 'library.properties');
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 256000) continue;
      try {
        const props = properties(await fs.readFile(file));
        if (props.name)
          found.push({ name: props.name, version: props.version, path: directory, kind: 'core' });
      } catch {}
    }
    return found;
  }
  private async fetchBytes(
    url: string,
    limit: number,
    hooks: ComponentOperationHooks = {},
    size?: number,
  ): Promise<Buffer> {
    this.abort(hooks);
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'downloads.arduino.cc' ||
      parsed.username ||
      parsed.password ||
      !parsed.pathname.startsWith('/libraries/')
    )
      throw new Error('error.componentDownload');
    const signals = [AbortSignal.timeout(300000), this.options.signal, hooks.signal].filter(
      (value): value is AbortSignal => !!value,
    );
    const response = await (hooks.fetcher ?? this.options.fetcher ?? fetch)(url, {
      signal: AbortSignal.any(signals),
      redirect: 'error',
      headers: { 'User-Agent': 'Blode-Studio' },
    });
    if (!response.ok || !response.body) throw new Error(`error.componentDownload: HTTP ${response.status}`);
    const chunks: Buffer[] = [];
    let received = 0,
      last = 0;
    for await (const chunk of response.body) {
      this.abort(hooks);
      received += chunk.byteLength;
      if (received > limit || (size !== undefined && received > size))
        throw new Error('error.componentTooLarge');
      chunks.push(Buffer.from(chunk));
      if (Date.now() - last > 200) {
        hooks.progress?.({
          tool: 'Arduino libraries',
          phase: 'downloading',
          receivedBytes: received,
          totalBytes: size,
        });
        last = Date.now();
      }
    }
    hooks.progress?.({
      tool: 'Arduino libraries',
      phase: 'downloading',
      receivedBytes: received,
      totalBytes: size,
    });
    return Buffer.concat(chunks);
  }
  private async index(hooks: ComponentOperationHooks = {}): Promise<Map<string, Release[]>> {
    if (this.catalog && Date.now() - this.catalog.time < 6 * 60 * 60 * 1000) return this.catalog.entries;
    if (this.catalogPending) return this.catalogPending;
    this.catalogPending = (async () => {
      const cacheDirectory = path.join(this.options.dataRoot, 'component-cache');
      const cacheFile = path.join(cacheDirectory, 'arduino-library-index.gz');
      let bytes: Buffer | undefined;
      let fromCache = false;
      const info = await fs.lstat(cacheFile).catch(() => null);
      if (
        info?.isFile() &&
        !info.isSymbolicLink() &&
        info.size <= 16 * 1024 * 1024 &&
        Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000
      ) {
        bytes = await fs.readFile(cacheFile);
        fromCache = true;
      }
      const decode = (content: Buffer) => {
        const decoded =
          content[0] === 0x1f && content[1] === 0x8b
            ? gunzipSync(content, { maxOutputLength: 128 * 1024 * 1024 })
            : content;
        const value = JSON.parse(decoded.toString('utf8'));
        if (!Array.isArray(value?.libraries) || value.libraries.length > 250000)
          throw new Error('error.componentIndex');
        return value;
      };
      let json: any;
      if (bytes)
        try {
          json = decode(bytes);
        } catch {
          bytes = undefined;
          fromCache = false;
        }
      if (!bytes) {
        bytes = await this.fetchBytes(ARDUINO_LIBRARY_INDEX_URL, 16 * 1024 * 1024, hooks);
        try {
          json = decode(bytes);
        } catch {
          throw new Error('error.componentIndex');
        }
      }
      const entries = new Map<string, Release[]>();
      for (const item of json.libraries) {
        if (
          !item ||
          typeof item.name !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(item.name) ||
          typeof item.version !== 'string' ||
          item.version.length > 64
        )
          continue;
        try {
          compareComponentVersions(item.version, item.version);
          if (
            typeof item.url !== 'string' ||
            !item.url.startsWith('https://downloads.arduino.cc/libraries/') ||
            !Number.isSafeInteger(item.size) ||
            item.size < 1 ||
            item.size > MAX_FILE ||
            typeof item.checksum !== 'string' ||
            !/^SHA-256:[a-f0-9]{64}$/i.test(item.checksum)
          )
            continue;
          if (
            item.dependencies !== undefined &&
            (!Array.isArray(item.dependencies) || item.dependencies.length > 128)
          )
            continue;
          const dependencies = (item.dependencies ?? []).map((entry: any) => {
            if (
              typeof entry.name !== 'string' ||
              (entry.version !== undefined && typeof entry.version !== 'string')
            )
              throw Error();
            return parseComponentDependencies(entry.name + (entry.version ? ` (${entry.version})` : ''))[0];
          });
          if (dependencies.length > 128) continue;
          const release: Release = {
            name: item.name,
            version: item.version,
            url: item.url,
            size: item.size,
            checksum: item.checksum.slice(8).toLowerCase(),
            dependencies,
            author: typeof item.author === 'string' ? item.author.slice(0, 1024) : undefined,
            description: typeof item.sentence === 'string' ? item.sentence.slice(0, 2048) : undefined,
            website: typeof item.website === 'string' ? item.website.slice(0, 2048) : undefined,
          };
          const key = keyOf(item.name),
            values = entries.get(key) ?? [];
          if (!values.some((value) => value.version === release.version) && values.length < 1000) {
            values.push(release);
            entries.set(key, values);
          }
        } catch {
          /* A malformed publisher record cannot invalidate unrelated packages. */
        }
      }
      for (const releases of entries.values())
        releases.sort((a, b) => compareComponentVersions(b.version, a.version));
      if (!entries.size) throw new Error('error.componentIndex');
      // This cache contains public metadata only; failed persistence does not affect search/install.
      if (!fromCache)
        await fs
          .mkdir(cacheDirectory, { recursive: true })
          .then(async () => {
            const temporary = cacheFile + '.' + randomUUID() + '.tmp';
            try {
              await fs.writeFile(temporary, bytes!, { flag: 'wx' });
              await fs.rename(temporary, cacheFile);
            } finally {
              await fs.unlink(temporary).catch(() => {});
            }
          })
          .catch(() => {});
      this.catalog = { time: Date.now(), entries };
      return entries;
    })();
    try {
      return await this.catalogPending;
    } finally {
      this.catalogPending = undefined;
    }
  }
  async search(query: string): Promise<ComponentSearchResult> {
    if (typeof query !== 'string' || query.length > 200) throw new Error('error.invalidArguments');
    const needle = query.trim().toLowerCase();
    const catalog = await this.index();
    const matches = [...catalog.values()]
      .filter(
        (values) =>
          !needle || `${values[0].name} ${values[0].description ?? ''}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => a[0].name.localeCompare(b[0].name));
    return {
      query,
      entries: matches.slice(0, 100).map((values) => ({
        name: values[0].name,
        author: values[0].author,
        description: values[0].description,
        latestVersion: values[0].version,
        versions: values.map((value) => value.version),
        url: values[0].website,
        dependencies: values[0].dependencies.map(dependencyLabel),
        dependenciesByVersion: Object.fromEntries(
          values.map((value) => [value.version, value.dependencies.map(dependencyLabel)]),
        ),
      })),
      truncated: matches.length > 100,
    };
  }
  private async dependencies(
    required: ComponentDependency[],
    manifest: ComponentManifest,
    provided: ComponentProvidedLibrary[],
    hooks: ComponentOperationHooks,
    seed: Payload[] = [],
  ): Promise<Payload[]> {
    if (!required.length) return seed;
    const fixed = new Map<string, string | undefined>(
      [...provided, ...manifest.components, ...seed.map((item) => item.library)].map((item) => [
        keyOf(item.name),
        item.version,
      ]),
    );
    // Local imports with all dependencies already available remain usable offline.
    if (
      required.every(
        (value) =>
          fixed.has(keyOf(value.name)) &&
          (!value.constraint ||
            (!!fixed.get(keyOf(value.name)) &&
              componentVersionMatches(fixed.get(keyOf(value.name))!, value.constraint))),
      )
    )
      return seed;
    const catalog = await this.index(hooks),
      downloaded = new Map<string, Payload>();
    for (let pass = 0; pass < 129; pass++) {
      this.abort(hooks);
      const selected = resolveComponentDependencies(catalog, required, fixed, (release) => {
        const actual = downloaded.get(`${release.name}@${release.version}`);
        return actual
          ? parseComponentDependencies(actual.library.dependencies.join(','))
          : release.dependencies;
      });
      let pending = false;
      for (const release of selected) {
        const id = `${release.name}@${release.version}`;
        if (downloaded.has(id)) continue;
        pending = true;
        hooks.log?.(`${release.name} ${release.version}`);
        const bytes = await this.fetchBytes(release.url, MAX_FILE, hooks, release.size);
        hooks.progress?.({ tool: release.name, phase: 'verifying' });
        if (bytes.length !== release.size || hash(bytes) !== release.checksum)
          throw new Error(`error.componentChecksum: ${release.name}`);
        hooks.progress?.({ tool: release.name, phase: 'extracting' });
        const item = payload(unwrap(readComponentZip(bytes)), release.name, {
          type: 'arduino',
          url: release.url,
        });
        if (
          item.library.kind !== 'arduino' ||
          item.library.name !== release.name ||
          !item.library.version ||
          compareComponentVersions(item.library.version, release.version) !== 0
        )
          throw new Error(`error.componentManifest: ${release.name}`);
        item.library.version = release.version;
        downloaded.set(id, item);
        if (
          [...downloaded.values(), ...seed].reduce(
            (sum, value) => sum + [...value.files.values()].reduce((n, file) => n + file.length, 0),
            0,
          ) >
          MAX_TOTAL * 2
        )
          throw new Error('error.componentTooLarge');
      }
      if (!pending)
        return [...seed, ...selected.map((release) => downloaded.get(`${release.name}@${release.version}`)!)];
    }
    throw new Error('error.componentDependency');
  }
  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.mutating) throw new Error('error.busy');
    this.mutating = true;
    try {
      return await action();
    } finally {
      this.mutating = false;
    }
  }
  private async workspaceDirectory(root: string, relative: string): Promise<string> {
    const target = path.resolve(root, relative);
    if (!safeRelative(relative) || !within(root, target)) throw new Error('error.componentPath');
    let current = root;
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      let info = await fs.lstat(current).catch(() => null);
      if (!info) {
        await fs.mkdir(current);
        info = await fs.lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await fs.realpath(current)))
        throw new Error('error.componentPath');
    }
    return target;
  }
  private async existingDirectory(root: string, relative: string): Promise<string> {
    if (!safeRelative(relative)) throw new Error('error.componentPath');
    let current = root;
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      const info = await fs.lstat(current).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink() || !within(root, await fs.realpath(current)))
        throw new Error('error.componentPath');
    }
    return current;
  }
  private async writeManifest(root: string, manifest: ComponentManifest, before: string | null) {
    await this.sameProject(root);
    const file = path.join(root, COMPONENT_MANIFEST_FILE);
    const current = await fs.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current !== before) throw new Error('error.componentChanged');
    const text = JSON.stringify(componentManifestSchema.parse(manifest), null, 2) + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST) throw new Error('error.componentTooLarge');
    const temporary = path.join(root, `.blode-components-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, text, { flag: 'wx' });
      await renameWithRetry(temporary, file, async () => {
        await this.sameProject(root);
        if ((await manifestSnapshot(root)).text !== before) throw new Error('error.componentChanged');
        const info = await fs.lstat(temporary);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('error.componentPath');
      });
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
  private async commit(
    root: string,
    before: ComponentManifest,
    filesBefore: string | null,
    payloads: Payload[],
    hooks: ComponentOperationHooks,
  ) {
    this.abort(hooks);
    await this.sameProject(root);
    const names = new Set(before.components.map((component) => keyOf(component.name))),
      targets = new Set(before.components.map((component) => keyOf(component.path)));
    for (const item of payloads) {
      if (names.has(keyOf(item.library.name)) || targets.has(keyOf(item.library.path)))
        throw new Error(`error.componentExists: ${item.library.name}`);
      names.add(keyOf(item.library.name));
      targets.add(keyOf(item.library.path));
      if (await fs.lstat(path.join(root, item.library.path)).catch(() => null))
        throw new Error(`error.componentExists: ${item.library.path}`);
    }
    const internal = await this.workspaceDirectory(root, '.blode');
    const stage = await fs.mkdtemp(path.join(internal, 'components-import-'));
    const promoted: { destination: string; library: ManagedComponentLibrary }[] = [];
    try {
      for (const item of payloads) {
        const destination = path.join(stage, item.library.path);
        for (const relative of item.directories ?? []) {
          if (!safeRelative(relative)) throw new Error('error.componentPath');
          await fs.mkdir(path.join(destination, relative), { recursive: true });
        }
        for (const [relative, bytes] of item.files) {
          this.abort(hooks);
          if (!safeRelative(relative)) throw new Error('error.componentPath');
          const full = path.join(destination, relative);
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, bytes, { flag: 'wx' });
        }
      }
      await this.sameProject(root);
      this.abort(hooks);
      for (const item of payloads) {
        hooks.progress?.({ tool: item.library.name, phase: 'installing' });
        await this.workspaceDirectory(root, path.posix.dirname(item.library.path));
        const destination = path.join(root, item.library.path);
        const source = path.join(stage, item.library.path);
        await renameWithRetry(source, destination, async () => {
          this.abort(hooks);
          await this.sameProject(root);
          await this.existingDirectory(root, slash(path.relative(root, source)));
          await this.existingDirectory(root, path.posix.dirname(item.library.path));
          if (await fs.lstat(destination).catch(() => null)) throw new Error('error.componentExists');
        });
        promoted.push({ destination, library: item.library });
      }
      await this.writeManifest(
        root,
        { version: 1, components: [...before.components, ...payloads.map((item) => item.library)] },
        filesBefore,
      );
    } catch (error) {
      for (const { destination, library } of promoted.reverse())
        if (
          within(root, destination) &&
          (await this.existingDirectory(root, library.path).catch(() => null)) &&
          (await this.unchanged(destination, library))
        )
          await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      if (within(internal, stage)) await fs.rm(stage, { recursive: true, force: true });
    }
    return this.state(root);
  }
  private async transaction(
    expected: string,
    hooks: ComponentOperationHooks,
    prepare: (
      root: string,
      manifest: ComponentManifest,
      provided: ComponentProvidedLibrary[],
    ) => Promise<Payload[]>,
  ) {
    const root = await this.root(expected);
    this.abort(hooks);
    const { manifest, text } = await manifestSnapshot(root);
    const result = await prepare(root, manifest, await this.provided());
    return this.commit(root, manifest, text, result, hooks);
  }
  async install(
    request: ComponentInstallRequest,
    hooks: ComponentOperationHooks = {},
  ): Promise<ComponentLibrariesState> {
    if (
      request.confirm !== true ||
      !request.expectedProjectRoot ||
      typeof request.name !== 'string' ||
      typeof request.version !== 'string'
    )
      throw new Error('error.invalidArguments');
    componentVersionMatches(request.version);
    return this.mutate(() =>
      this.transaction(request.expectedProjectRoot, hooks, async (_root, manifest, provided) => {
        if (manifest.components.some((item) => keyOf(item.name) === keyOf(request.name)))
          throw new Error('error.componentExists');
        if (provided.some((item) => keyOf(item.name) === keyOf(request.name)))
          throw new Error('error.componentProvided');
        return this.dependencies(
          [{ name: request.name, constraint: '=' + request.version }],
          manifest,
          provided,
          hooks,
        );
      }),
    );
  }
  async importDirectory(
    directory: string,
    expectedProjectRoot: string,
    hooks: ComponentOperationHooks = {},
  ): Promise<ComponentLibrariesState> {
    if (typeof expectedProjectRoot !== 'string' || !expectedProjectRoot)
      throw new Error('error.invalidArguments');
    return this.mutate(() =>
      this.transaction(expectedProjectRoot, hooks, async (root, manifest, provided) => {
        if (within(await fs.realpath(directory), root)) throw new Error('error.componentPath');
        const item = payload(await readComponentDirectory(directory), path.basename(directory), {
          type: 'directory',
        });
        if (provided.some((value) => keyOf(value.name) === keyOf(item.library.name)))
          throw new Error('error.componentProvided');
        return this.dependencies(
          parseComponentDependencies(item.library.dependencies.join(',')),
          manifest,
          provided,
          hooks,
          [item],
        );
      }),
    );
  }
  async importArchive(
    file: string,
    expectedProjectRoot: string,
    hooks: ComponentOperationHooks = {},
  ): Promise<ComponentLibrariesState> {
    if (typeof expectedProjectRoot !== 'string' || !expectedProjectRoot)
      throw new Error('error.invalidArguments');
    return this.mutate(() =>
      this.transaction(expectedProjectRoot, hooks, async (_root, manifest, provided) => {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOTAL)
          throw new Error('error.componentArchive');
        const files = unwrap(readComponentZip(await fs.readFile(file), { maxArchive: MAX_TOTAL }));
        const { readComponentPackage } = await import('./component-package');
        const bundle = readComponentPackage(files);
        if (bundle) {
          for (const item of bundle)
            if (provided.some((value) => keyOf(value.name) === keyOf(item.library.name)))
              throw new Error('error.componentProvided');
          const required = bundle.flatMap((item) =>
            parseComponentDependencies(item.library.dependencies.join(',')),
          );
          return this.dependencies(required, manifest, provided, hooks, bundle);
        }
        const item = payload(unwrap(files), path.basename(file, path.extname(file)), { type: 'archive' });
        if (provided.some((value) => keyOf(value.name) === keyOf(item.library.name)))
          throw new Error('error.componentProvided');
        return this.dependencies(
          parseComponentDependencies(item.library.dependencies.join(',')),
          manifest,
          provided,
          hooks,
          [item],
        );
      }),
    );
  }
  async remove(request: ComponentRemoveRequest): Promise<ComponentLibrariesState> {
    if (request.confirm !== true || !request.expectedProjectRoot || typeof request.id !== 'string')
      throw new Error('error.invalidArguments');
    return this.mutate(async () => {
      const root = await this.root(request.expectedProjectRoot),
        snapshot = await manifestSnapshot(root),
        manifest = snapshot.manifest;
      const component = manifest.components.find((item) => item.id === request.id);
      if (!component) throw new Error('error.componentMissing');
      if (
        manifest.components.some(
          (item) =>
            item.id !== component.id &&
            parseComponentDependencies(item.dependencies.join(',')).some(
              (dependency) => keyOf(dependency.name) === keyOf(component.name),
            ),
        )
      )
        throw new Error('error.componentInUse');
      const directory = await this.existingDirectory(root, component.path);
      if (!(await this.unchanged(directory, component))) throw new Error('error.componentChanged');
      const internal = await this.workspaceDirectory(root, '.blode');
      const trash = path.join(internal, 'components-remove-' + randomUUID());
      await renameWithRetry(directory, trash, async () => {
        await this.sameProject(root);
        await this.existingDirectory(root, component.path);
        await this.existingDirectory(root, '.blode');
        if (await fs.lstat(trash).catch(() => null)) throw new Error('error.componentExists');
      });
      try {
        if (!(await this.unchanged(trash, component))) throw new Error('error.componentChanged');
        await this.writeManifest(
          root,
          { version: 1, components: manifest.components.filter((item) => item.id !== component.id) },
          snapshot.text,
        );
      } catch (error) {
        await renameWithRetry(trash, directory, async () => {
          await this.existingDirectory(root, slash(path.relative(root, trash)));
          await this.existingDirectory(root, path.posix.dirname(component.path));
          if (await fs.lstat(directory).catch(() => null)) throw new Error('error.componentChanged');
        });
        throw error;
      }
      if (within(internal, trash)) await fs.rm(trash, { recursive: true, force: true });
      return this.state(root);
    });
  }
  private async unchanged(directory: string, component: ManagedComponentLibrary): Promise<boolean> {
    try {
      const files = await readComponentDirectory(directory, true);
      return (
        files.size === Object.keys(component.integrity).length &&
        [...files].every(([file, bytes]) => component.integrity[file] === hash(bytes))
      );
    } catch {
      return false;
    }
  }
}
