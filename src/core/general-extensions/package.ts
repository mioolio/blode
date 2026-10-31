import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readComponentZip } from '../component-zip';
import { extensionRelative, extensionValuesSchema, generalExtensionManifestSchema } from './schema';
import type { GeneralExtensionManifest } from '../../shared/general-extensions';

export interface ExtensionPackage {
  manifest: GeneralExtensionManifest;
  files: Map<string, Buffer>;
  fingerprint: string;
  bytes: number;
}
export const fingerprint = (files: Map<string, Buffer>) => {
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en')))
    hash.update(name).update('\0').update(createHash('sha256').update(bytes).digest()).update('\0');
  return hash.digest('hex');
};
export async function readExtensionDirectory(directory: string): Promise<Map<string, Buffer>> {
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('error.extensionPath');
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = async (current: string, depth: number) => {
    if (depth > 20) throw new Error('error.extensionSize');
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === '.signing') continue;
      if (entry.name === '.uel' && current === directory) continue;
      if (entry.isSymbolicLink()) throw new Error('error.extensionPath');
      const file = path.join(current, entry.name),
        relative = path.relative(directory, file).replaceAll('\\', '/');
      if (!extensionRelative.safeParse(relative).success) throw new Error('error.extensionPath');
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile()) {
        const stat = await fs.lstat(file);
        if (
          stat.nlink > 1 ||
          stat.size > 16_000_000 ||
          (total += stat.size) > 64_000_000 ||
          files.size >= 4096
        )
          throw new Error('error.extensionSize');
        const bytes = await fs.readFile(file);
        if (bytes.length !== stat.size) throw new Error('error.extensionChanged');
        files.set(relative, bytes);
      }
    }
  };
  await walk(directory, 0);
  return files;
}
export function parseExtensionPackage(files: Map<string, Buffer>): ExtensionPackage {
  if (!files.has('manifest.json')) {
    const names = [...files.keys()],
      prefix = names[0]?.split('/')[0] + '/';
    if (names.every((name) => name.startsWith(prefix)))
      files = new Map([...files].map(([name, bytes]) => [name.slice(prefix.length), bytes]));
  }
  let total = 0;
  for (const [file, bytes] of files) {
    if (!extensionRelative.safeParse(file).success) throw new Error('error.extensionPath');
    if (bytes.length > 16_000_000 || (total += bytes.length) > 64_000_000 || files.size > 4096)
      throw new Error('error.extensionSize');
  }
  const metadata = files.get('manifest.json');
  if (!metadata || metadata.length > 256_000) throw new Error('error.extensionManifest');
  let manifest: GeneralExtensionManifest;
  try {
    manifest = generalExtensionManifestSchema.parse(JSON.parse(metadata.toString('utf8')));
  } catch {
    throw new Error('error.extensionManifest');
  }
  const appearance = [
    manifest.ui.appearance,
    ...(manifest.ui.presets ?? []).map((preset) => preset.appearance),
  ];
  for (const file of [
    manifest.runtime,
    manifest.documentation,
    manifest.settings?.defaults,
    ...Object.values(manifest.locales ?? {}),
    ...(manifest.ui.views ?? []).map((view) => view.file),
    ...appearance.map((item) => item?.background),
  ].filter((value): value is string => !!value))
    if (!files.has(file)) throw new Error('error.extensionManifest');
  for (const file of Object.values(manifest.locales ?? {})) {
    const bytes = files.get(file)!;
    if (bytes.length > 256_000) throw new Error('error.extensionSize');
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((text) => typeof text !== 'string')
      )
        throw Error();
    } catch {
      throw new Error('error.extensionManifest');
    }
  }
  let defaults: import('../../shared/general-extensions').ExtensionValues = {};
  if (manifest.settings?.defaults) {
    const bytes = files.get(manifest.settings.defaults)!;
    if (bytes.length > 256_000) throw new Error('error.extensionSize');
    try {
      defaults = extensionValuesSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw new Error('error.extensionSettings');
    }
  }
  const fields = manifest.settings?.fields ?? [];
  const values = {
    ...Object.fromEntries(
      fields.filter((field) => field.default !== undefined).map((field) => [field.id, field.default!]),
    ),
    ...defaults,
  };
  for (const [id, value] of Object.entries(values)) {
    const field = fields.find((field) => field.id === id);
    if (
      !field ||
      (field.type === 'boolean' && typeof value !== 'boolean') ||
      (field.type === 'number' &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max))) ||
      (['text', 'select'].includes(field.type) && typeof value !== 'string') ||
      (field.type === 'select' && !field.options?.some((option) => option.value === value))
    )
      throw new Error('error.extensionSettings');
  }
  return { manifest, files, fingerprint: fingerprint(files), bytes: total };
}
export async function readExtensionSource(source: string): Promise<ExtensionPackage> {
  if (!path.isAbsolute(source) || /[\0\r\n]/.test(source)) throw new Error('error.extensionPath');
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat || stat.isSymbolicLink()) throw new Error('error.extensionPath');
  if (stat.isDirectory()) return parseExtensionPackage(await readExtensionDirectory(source));
  if (!stat.isFile() || stat.size > 64_000_000 || !/\.zip$/i.test(source))
    throw new Error('error.extensionArchive');
  try {
    return parseExtensionPackage(readComponentZip(await fs.readFile(source)));
  } catch (error) {
    if (error instanceof Error && /^error\.extension/.test(error.message)) throw error;
    throw new Error('error.extensionArchive');
  }
}
