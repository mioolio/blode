import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod';
import {
  componentManifestSchema,
  readComponentManifest,
  readComponentDirectory,
  safeComponentRelativePath,
} from './components';
import { parseComponentDependencies, componentVersionMatches } from './component-dependencies';
import { writeZip, type ZipEntry } from './zip';
import { verifyPackageFiles } from './package-signing';
import type {
  ComponentExportRequest,
  ComponentPackageResult,
  ManagedComponentLibrary,
  ComponentManifest,
} from '../shared/components';

const FILE = 'blode.components.package.json';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const schema = z
  .object({
    format: z.literal('blode-components'),
    version: z.literal(1),
    components: componentManifestSchema.shape.components,
    dependencies: z.array(z.string().max(512)).max(1024),
    directories: z.array(z.string().max(4096).refine(safeComponentRelativePath)).max(10000).optional(),
  })
  .strict();
export function readComponentPackage(
  files: Map<string, Buffer>,
): { library: ManagedComponentLibrary; files: Map<string, Buffer>; directories?: string[] }[] | null {
  const manifest = files.get(FILE);
  if (!manifest) return null;
  if (manifest.length > 8_000_000) throw new Error('error.componentManifest');
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(JSON.parse(manifest.toString('utf8')));
    componentManifestSchema.parse({ version: 1, components: parsed.components });
    if (
      new Set(parsed.directories?.map((directory) => directory.toLowerCase())).size !==
      (parsed.directories?.length ?? 0)
    )
      throw new Error('error.componentManifest');
  } catch {
    throw new Error('error.componentManifest');
  }
  const consumed = new Set([FILE, ...(files.has('obe') ? ['obe'] : [])]);
  const modified = verifyPackageFiles(files, { kind: 'component' }).status === 'tampered';
  const payloads = parsed.components.map((library) => {
    const result = new Map<string, Buffer>();
    for (const [relative, digest] of Object.entries(library.integrity)) {
      const name = library.path + '/' + relative,
        bytes = files.get(name);
      if (!bytes || (!modified && sha(bytes) !== digest)) throw new Error('error.componentChecksum');
      result.set(relative, bytes);
      consumed.add(name);
    }
    if (!result.size) throw new Error('error.componentManifest');
    for (const source of library.sources)
      if (!result.has(source.slice(library.path.length + 1))) throw new Error('error.componentManifest');
    for (const include of library.includes)
      if (
        include !== library.path &&
        !result.has(include.slice(library.path.length + 1)) &&
        ![...result.keys()].some((file) => file.startsWith(include.slice(library.path.length + 1) + '/')) &&
        !parsed.directories?.includes(include)
      )
        throw new Error('error.componentManifest');
    return {
      library: modified
        ? {
            ...library,
            integrity: Object.fromEntries([...result].map(([name, bytes]) => [name, sha(bytes)])),
          }
        : library,
      files: result,
      directories: parsed.directories
        ?.filter((dir) => dir.startsWith(library.path + '/'))
        .map((dir) => dir.slice(library.path.length + 1)),
    };
  });
  if (files.size !== consumed.size) throw new Error('error.componentManifest');
  if (
    parsed.directories?.some(
      (dir) =>
        !parsed.components.some(
          (component) => dir === component.path || dir.startsWith(component.path + '/'),
        ),
    )
  )
    throw new Error('error.componentManifest');
  return payloads;
}
export class ComponentPackages {
  private artifacts = new Map<string, { path: string; name: string }>();
  constructor(private readonly options: { dataRoot: string; projectRoot: () => string }) {}
  async export(request: ComponentExportRequest): Promise<ComponentPackageResult> {
    if (request.confirm !== true || !request.expectedProjectRoot) throw new Error('error.invalidArguments');
    const root = await fs.realpath(this.options.projectRoot());
    if (path.resolve(request.expectedProjectRoot) !== path.resolve(root))
      throw new Error('error.projectChanged');
    const manifest = await readComponentManifest(root),
      chosen = new Map<string, ManagedComponentLibrary>();
    const queue = request.ids?.length ? request.ids : manifest.components.map((item) => item.id);
    for (const id of queue) {
      const item = manifest.components.find((item) => item.id === id);
      if (!item) throw new Error('error.componentManifest');
      chosen.set(item.id, item);
    }
    const external = new Set<string>();
    for (const item of chosen.values())
      for (const dep of parseComponentDependencies(item.dependencies.join(','))) {
        const local = manifest.components.find(
          (value) => value.name.toLowerCase() === dep.name.toLowerCase(),
        );
        if (!local) {
          external.add(dep.name + (dep.constraint ? ' ' + dep.constraint : ''));
          continue;
        }
        if (dep.constraint && (!local.version || !componentVersionMatches(local.version, dep.constraint)))
          throw new Error('error.componentDependencyConflict');
        chosen.set(local.id, local);
      }
    if (!chosen.size) throw new Error('error.componentManifest');
    const entries: ZipEntry[] = [],
      components: ManagedComponentLibrary[] = [],
      directories: string[] = [];
    let total = 0;
    for (const item of chosen.values()) {
      const location = path.join(root, item.path),
        relative = path.relative(root, await fs.realpath(location));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('error.componentPath');
      const files = await readComponentDirectory(location);
      for (const source of item.sources)
        if (!files.has(source.slice(item.path.length + 1))) throw new Error('error.componentChanged');
      for (const include of item.includes) {
        const stat = await fs.lstat(path.join(root, include)).catch(() => null);
        if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          throw new Error('error.componentChanged');
        if (stat.isDirectory()) directories.push(include);
      }
      components.push({
        ...item,
        integrity: Object.fromEntries([...files].map(([name, bytes]) => [name, sha(bytes)])),
      });
      for (const [name, data] of files) {
        if ((total += data.length) > 250_000_000 || entries.length >= 9998)
          throw new Error('error.componentTooLarge');
        entries.push({ path: item.path + '/' + name, data });
      }
    }
    const bundle = {
      format: 'blode-components',
      version: 1,
      components,
      dependencies: [...external],
      directories,
    };
    schema.parse(bundle);
    entries.push({ path: FILE, data: Buffer.from(JSON.stringify(bundle, null, 2) + '\n') });
    if (path.resolve(this.options.projectRoot()) !== root) throw new Error('error.projectChanged');
    const id = randomUUID(),
      directory = path.join(this.options.dataRoot, 'exports');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, id + '.zip');
    try {
      await writeZip(
        file,
        (async function* () {
          yield* entries;
        })(),
      );
    } catch (error) {
      await fs.unlink(file).catch(() => {});
      throw error;
    }
    const name = (path.basename(root).replace(/[^\p{L}\p{N}_.-]/gu, '_') || 'project') + '-components.zip';
    this.artifacts.set(id, { path: file, name });
    return {
      id,
      name,
      size: (await fs.stat(file)).size,
      sha256: sha(await fs.readFile(file)),
      componentCount: components.length,
      dependencies: [...external],
    };
  }
  download(id: string) {
    const item = this.artifacts.get(id);
    if (!item) throw new Error('error.packageExpired');
    return item;
  }
}
