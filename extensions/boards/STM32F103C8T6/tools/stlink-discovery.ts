import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface StlinkSearchOptions {
  /** Managed ST-Link package root, not the shared toolchain root. */
  root: string;
  directory?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  tools?: readonly string[];
}

/** Package roots and bin directories are accepted by every ST-Link consumer. */
export async function stlinkBinaryDirectories(options: StlinkSearchOptions): Promise<string[]> {
  const { directory } = options;
  if (directory && /[\r\n\0]/.test(directory)) throw new Error('errors.stlinkMissing');
  const root = path.resolve(directory || options.root);
  const candidates = [path.join(root, 'bin'), root];
  const platform = options.platform ?? process.platform;
  if (!directory) {
    const versions = path.join(path.dirname(root), 'versions', 'stlink');
    const entries = await fs.readdir(versions, { withFileTypes: true }).catch(() => []);
    for (const entry of entries
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
      .slice(0, 64)) {
      candidates.push(path.join(versions, entry.name, 'bin'), path.join(versions, entry.name));
    }
    const env = options.env ?? process.env;
    candidates.push(
      ...(env.PATH ?? env.Path ?? '')
        .split(platform === 'win32' ? ';' : ':')
        .map((value) => value.replace(/^"|"$/g, ''))
        .filter((value) => path.isAbsolute(value))
        .slice(0, 128),
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const bin of candidates) {
    const identity = platform === 'win32' ? bin.toLowerCase() : bin;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const files = await Promise.all(
      (options.tools ?? ['st-info', 'st-flash']).map((name) =>
        fs.lstat(path.join(bin, name + (platform === 'win32' ? '.exe' : ''))).catch(() => null),
      ),
    );
    if (files.every((file) => file?.isFile() && !file.isSymbolicLink())) result.push(bin);
  }
  return result;
}

export function stlinkPackageDirectory(binaryDirectory: string): string {
  return path.basename(binaryDirectory).toLowerCase() === 'bin'
    ? path.dirname(binaryDirectory)
    : binaryDirectory;
}
