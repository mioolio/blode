import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getBoardAdapter } from '../../extensions/registry';
import { parseRuntimePluginManifest } from './runtime-plugin-schema';
import { writeZip, type ZipEntry } from './zip';
import { readDevicePackage } from './device-package-source';
import { assertPackageApproval, verifyPackageFiles, verifyPackageDirectory } from './package-signing';
import { packageHealth } from '../shared/package-health';
import type { PackageHealth } from '../shared/package-health';
import { privateDeviceFile } from './device-package-source';
import type { PackageApproval } from '../shared/package-signing';
import type { DevicePackageReview } from '../shared/device-packages';
import type { RuntimePluginsState } from '../shared/plugins';
import type { DevicePackageExport, DevicePackageInfo, DevicePackagesState } from '../shared/device-packages';

const builtins = ['Esp32_S3_CAM', 'STM32F103C8T6'] as const;
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const excluded = (name: string) =>
  name.startsWith('.') ||
  [
    'node_modules',
    'cache',
    'caches',
    '__pycache__',
    'logs',
    'tmp',
    'temp',
    'coverage',
    'package-manifest.json',
  ].includes(name.toLowerCase()) ||
  /(?:\.map|\.log|\.pyc|\.key|\.pem|\.pfx|\.p12)$/i.test(name) ||
  /^(?:credentials|secrets|settings\.local)(?:\.|$)/i.test(name);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Exports declarative packages and their resources without importing plugin JavaScript. */
export class DevicePackages {
  private archives = new Map<string, { path: string; name: string }>();
  private reviews = new Map<string, { source: string; fingerprint: string; expires: number }>();
  private installing = false;
  constructor(
    private readonly options: {
      dataRoot: string;
      builtinRoot: string;
      plugins: () => Promise<RuntimePluginsState>;
      reload?: () => Promise<void>;
      enforceSignatures?: boolean;
    },
  ) {}

  async review(request: { path: string }): Promise<DevicePackageReview> {
    const loaded = await readDevicePackage(request.path);
    if ((await this.state()).packages.some((item) => item.id === loaded.manifest.id))
      throw new Error('error.runtimePluginDuplicate');
    for (const [id, item] of this.reviews) if (item.expires < Date.now()) this.reviews.delete(id);
    if (this.reviews.size >= 8) this.reviews.delete(this.reviews.keys().next().value!);
    const ticket = randomUUID();
    this.reviews.set(ticket, {
      source: request.path,
      fingerprint: loaded.fingerprint,
      expires: Date.now() + 300_000,
    });
    return {
      ticket,
      fingerprint: loaded.fingerprint,
      id: loaded.manifest.id,
      name: loaded.manifest.name,
      version: loaded.manifest.version,
      support: loaded.manifest.support.chips,
      fileCount: loaded.files.size,
      bytes: loaded.bytes,
      verification: verifyPackageFiles(loaded.files, {
        kind: 'device',
        id: loaded.manifest.id,
        version: loaded.manifest.version,
      }),
    };
  }

  async install(request: {
    approval?: PackageApproval;
    ticket: string;
    fingerprint: string;
    confirm: true;
  }): Promise<DevicePackagesState> {
    if (request.confirm !== true) throw new Error('error.invalidArguments');
    if (this.installing) throw new Error('error.busy');
    const reviewed = this.reviews.get(request.ticket);
    this.reviews.delete(request.ticket);
    if (!reviewed || reviewed.expires < Date.now() || reviewed.fingerprint !== request.fingerprint)
      throw new Error('error.extensionChanged');
    this.installing = true;
    let stage = '';
    try {
      const loaded = await readDevicePackage(reviewed.source);
      if (loaded.fingerprint !== reviewed.fingerprint) throw new Error('error.extensionChanged');
      if (this.options.enforceSignatures || request.approval)
        assertPackageApproval(
          verifyPackageFiles(loaded.files, {
            kind: 'device',
            id: loaded.manifest.id,
            version: loaded.manifest.version,
          }),
          request.approval,
        );
      if ((await this.state()).packages.some((item) => item.id === loaded.manifest.id))
        throw new Error('error.runtimePluginDuplicate');
      const root = path.join(this.options.dataRoot, 'plugins');
      await fs.mkdir(root, { recursive: true });
      if (
        (await fs.lstat(root)).isSymbolicLink() ||
        !inside(await fs.realpath(this.options.dataRoot), await fs.realpath(root))
      )
        throw new Error('error.runtimePluginPath');
      const destination = path.join(root, loaded.manifest.id);
      if (await fs.lstat(destination).catch(() => null)) throw new Error('error.runtimePluginDuplicate');
      stage = await fs.mkdtemp(path.join(root, '.install-'));
      for (const [file, bytes] of loaded.files) {
        const target = path.join(stage, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, {
          flag: 'wx',
          mode: file === loaded.manifest.compiler.defaultTool?.executable ? 0o755 : 0o644,
        });
      }
      await fs.rename(stage, destination);
      stage = '';
      await this.options.reload?.();
      return this.state();
    } finally {
      if (
        stage &&
        inside(path.join(this.options.dataRoot, 'plugins'), stage) &&
        path.basename(stage).startsWith('.install-')
      )
        await fs.rm(stage, { recursive: true, force: true });
      this.installing = false;
    }
  }

  async state(): Promise<DevicePackagesState> {
    const packages: DevicePackageInfo[] = builtins.map((id) => {
      const manifest = getBoardAdapter(id).definition.runtimePlugin!;
      return {
        id,
        name: manifest.name,
        version: manifest.version,
        source: 'builtin',
        directory: path.join(this.options.builtinRoot, `${id}_Module`),
        exportId: `${id}_Module`,
        support: manifest.support.chips,
        transport: manifest.transport,
      };
    });
    for (const plugin of (await this.options.plugins()).plugins) {
      if (builtins.some((id) => id === plugin.id)) continue;
      packages.push({
        id: plugin.id,
        name: plugin.name,
        version: plugin.manifest.version,
        source: 'plugin',
        directory: plugin.directory,
        exportId: plugin.id,
        support: plugin.manifest.support.chips,
        transport: plugin.manifest.transport,
      });
    }
    return { packages };
  }

  async verify(ids: string[]): Promise<{ id: string; health: PackageHealth }[]> {
    if (ids.length > 25 || new Set(ids).size !== ids.length) throw new Error('error.invalidArguments');
    const packages = (await this.state()).packages;
    const entries = ids.map((id) => {
      const entry = packages.find((item) => item.id === id);
      if (!entry) throw new Error('error.devicePackageUnknown');
      return entry;
    });
    const result: { id: string; health: PackageHealth }[] = [];
    let index = 0;
    // Verify only visible rows, with two streaming readers even for a large library.
    const worker = async () => {
      for (;;) {
        const entry = entries[index++];
        if (!entry) return;
        try {
          const verification = await verifyPackageDirectory(
            entry.directory,
            {
              kind: 'device',
              id: entry.exportId,
              version: entry.version,
            },
            { exclude: (relative) => relative.split('/').some(privateDeviceFile) },
          );
          result.push({ id: entry.id, health: packageHealth(verification) });
        } catch {
          const signed = !!(await fs.lstat(path.join(entry.directory, 'obe')).catch(() => null));
          result.push({ id: entry.id, health: signed ? 'danger' : 'abnormal' });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return result;
  }

  async export(request: { id: string; confirm: true }): Promise<DevicePackageExport> {
    if (request.confirm !== true) throw new Error('error.invalidArguments');
    const entry = (await this.state()).packages.find((item) => item.id === request.id);
    if (!entry) throw new Error('error.devicePackageUnknown');
    const stat = await fs.lstat(entry.directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('error.runtimePluginPath');
    const root = await fs.realpath(entry.directory);
    const hasObe = !!(await fs.lstat(path.join(root, 'obe')).catch(() => null));
    const files = new Map<string, { source: string; size: number; mode: number }>();
    let total = 0;
    const walk = async (directory: string, depth: number) => {
      if (depth > 30) throw new Error('error.packageTooLarge');
      for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        if (excluded(item.name) && !(hasObe && item.name === 'package-manifest.json')) continue;
        const source = path.join(directory, item.name);
        if (item.isSymbolicLink()) throw new Error('error.runtimePluginPath');
        if (item.isDirectory()) {
          await walk(source, depth + 1);
          continue;
        }
        const info = await fs.lstat(source);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink > 1 ||
          !inside(root, await fs.realpath(source))
        )
          throw new Error('error.runtimePluginPath');
        if (info.size > 100_000_000 || (total += info.size) > 500_000_000 || files.size >= 9000)
          throw new Error('error.packageTooLarge');
        const relative = path.relative(root, source).replaceAll('\\', '/');
        files.set(relative, { source, size: info.size, mode: info.mode & 0o777 });
      }
    };
    await walk(root, 0);
    const metadata = files.get('manifest.json');
    if (!metadata || metadata.size > 256_000) throw new Error('error.runtimePluginManifest');
    const manifest = parseRuntimePluginManifest(JSON.parse(await fs.readFile(metadata.source, 'utf8')));
    if (manifest.id !== entry.exportId || manifest.version !== entry.version)
      throw new Error('error.extensionChanged');
    const required = [
      manifest.runtime,
      manifest.documentation,
      manifest.compiler.defaultTool?.executable,
      manifest.debugger.view,
      manifest.ui.view,
      ...(manifest.ui.views?.map((view) => view.file) ?? []),
      ...(manifest.languages?.entries.flatMap((language) => [
        ...language.catalogs,
        ...Object.values(language.standards ?? {}).flat(),
      ]) ?? []),
    ].filter((value): value is string => !!value);
    for (const file of required)
      if (!files.has(file.replaceAll('\\', '/'))) throw new Error('error.runtimePluginPath');
    const directory = path.join(this.options.dataRoot, 'device-package-exports');
    await fs.mkdir(directory, { recursive: true });
    const id = randomUUID(),
      file = path.join(directory, `${id}.zip`);
    const name = `${entry.exportId}-${entry.version.replace(/[^A-Za-z0-9_.-]/g, '-')}.zip`;
    try {
      const hashes: { path: string; size: number; sha256: string }[] = [];
      async function* entries(): AsyncGenerator<ZipEntry> {
        for (const [relative, item] of files) {
          const bytes = await fs.readFile(item.source);
          if (bytes.length !== item.size) throw new Error('error.packageChanged');
          hashes.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
          yield { path: `${entry!.exportId}/${relative}`, data: bytes, mode: item.mode };
        }
        if (!files.has('obe'))
          yield {
            path: `${entry!.exportId}/package-manifest.json`,
            data: Buffer.from(
              JSON.stringify({ id: entry!.exportId, version: entry!.version, files: hashes }, null, 2) + '\n',
            ),
          };
      }
      const size = await writeZip(file, entries());
      const sha256 = hash(await fs.readFile(file));
      this.archives.set(id, { path: file, name });
      return { id, name, size, sha256 };
    } catch (error) {
      await fs.unlink(file).catch(() => {});
      throw error;
    }
  }

  download(id: string): { path: string; name: string } {
    const archive = this.archives.get(id);
    if (!archive) throw new Error('error.packageExpired');
    return archive;
  }
}
