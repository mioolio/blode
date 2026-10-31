import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readZip } from './zip-reader';
import { parseRuntimePluginManifest } from './runtime-plugin-schema';

export const privateDeviceFile = (name: string) =>
  name.startsWith('.') ||
  /^(?:node_modules|cache|caches|__pycache__|logs|tmp|temp|coverage)$/i.test(name) ||
  /(?:\.map|\.log|\.pyc|\.key|\.pem|\.pfx|\.p12)$/i.test(name) ||
  /^(?:credentials|secrets|settings\.local)(?:\.|$)/i.test(name);
const safe = (file: string) =>
  !!file &&
  !path.isAbsolute(file) &&
  !path.win32.isAbsolute(file) &&
  !/[\\:\0-\x1f]/.test(file) &&
  !file.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part));
const requiredFiles = (manifest: ReturnType<typeof parseRuntimePluginManifest>) =>
  [
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
  ].filter((file): file is string => !!file);

/** Inspect data only; native runtime code is loaded later through the existing trust gate. */
export async function readDevicePackage(source: string) {
  if (!path.isAbsolute(source)) throw new Error('error.runtimePluginPath');
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('error.runtimePluginPath');
  let files = new Map<string, Buffer>();
  let total = 0;
  const add = (file: string, bytes: Buffer) => {
    if (!safe(file)) throw new Error('error.runtimePluginPath');
    if (file.split('/').some(privateDeviceFile)) return;
    if (
      files.has(file) ||
      files.size >= 9000 ||
      bytes.length > 100_000_000 ||
      (total += bytes.length) > 500_000_000
    )
      throw new Error('error.runtimePluginSize');
    files.set(file, bytes);
  };
  if (stat.isDirectory()) {
    const root = await fs.realpath(source);
    const walk = async (directory: string, depth: number) => {
      if (depth > 30) throw new Error('error.runtimePluginSize');
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (privateDeviceFile(entry.name)) continue;
        const full = path.join(directory, entry.name);
        const info = await fs.lstat(full);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
          throw new Error('error.runtimePluginPath');
        if (info.isDirectory()) await walk(full, depth + 1);
        else if (info.isFile()) {
          if (info.size > 100_000_000 || total + info.size > 500_000_000)
            throw new Error('error.runtimePluginSize');
          add(path.relative(root, full).replaceAll('\\', '/'), await fs.readFile(full));
        }
      }
    };
    await walk(root, 0);
  } else {
    if (!stat.isFile() || stat.size > 150_000_000 || !/\.zip$/i.test(source))
      throw new Error('error.runtimePluginPath');
    const entries = readZip(await fs.readFile(source), {
      maxArchive: 150_000_000,
      maxFile: 100_000_000,
      maxTotal: 500_000_000,
      maxEntries: 9000,
    });
    const candidates = [...entries.keys()].filter((file) => /(?:^|\/)manifest\.json$/.test(file));
    const marker = entries.has('manifest.json')
      ? 'manifest.json'
      : candidates.length === 1
        ? candidates[0]
        : '';
    if (!marker) throw new Error('error.runtimePluginManifest');
    const prefix = marker.slice(0, -'manifest.json'.length);
    for (const [file, bytes] of entries) {
      if (!file.startsWith(prefix)) throw new Error('error.runtimePluginPath');
      add(file.slice(prefix.length), bytes);
    }
  }
  const metadata = files.get('manifest.json');
  if (!metadata || metadata.length > 256_000) throw new Error('error.runtimePluginManifest');
  const manifest = parseRuntimePluginManifest(JSON.parse(metadata.toString('utf8')));
  if (!/\.[cm]?js$/i.test(manifest.runtime)) throw new Error('error.runtimePluginModule');
  for (const file of requiredFiles(manifest))
    if (!files.has(file.replaceAll('\\', '/'))) throw new Error('error.runtimePluginPath');
  const checksum = files.get('package-manifest.json');
  if (checksum) {
    if (checksum.length > 4_000_000) throw new Error('error.runtimePluginSize');
    const integrity = JSON.parse(checksum.toString('utf8'));
    if (
      integrity.id !== manifest.id ||
      integrity.version !== manifest.version ||
      !Array.isArray(integrity.files) ||
      integrity.files.length !== files.size - 1
    )
      throw new Error('error.toolPackageChecksum');
    const seen = new Set<string>();
    for (const record of integrity.files) {
      const bytes = files.get(record.path);
      if (
        !bytes ||
        seen.has(record.path) ||
        bytes.length !== record.size ||
        createHash('sha256').update(bytes).digest('hex') !== record.sha256
      )
        throw new Error('error.toolPackageChecksum');
      seen.add(record.path);
    }
  }
  const digest = createHash('sha256');
  for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en')))
    digest.update(file).update('\0').update(createHash('sha256').update(bytes).digest());
  return { manifest, files, fingerprint: digest.digest('hex'), bytes: total };
}
