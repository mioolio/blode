import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HostListing } from '../shared/host-workspace';

export async function browseHost(directory?: string): Promise<HostListing> {
  if (directory && (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)))
    throw new Error('error.invalidPath');
  const root = await fs.realpath(directory || os.homedir());
  if (!(await fs.stat(root)).isDirectory()) throw new Error('error.hostDirectoryRequired');
  const entries = await fs.readdir(root, { withFileTypes: true });
  const shown = entries
    .filter((entry) => !entry.isSymbolicLink())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const values = await Promise.all(
    shown.slice(0, 2000).map(async (entry) => ({
      name: entry.name,
      path: path.join(root, entry.name),
      directory: entry.isDirectory(),
      size: entry.isDirectory()
        ? 0
        : (await fs.stat(path.join(root, entry.name)).catch(() => ({ size: 0 }))).size,
    })),
  );
  const drives =
    process.platform === 'win32'
      ? (
          await Promise.all(
            Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).map(async (drive) =>
              (await fs.stat(drive).catch(() => null))?.isDirectory() ? drive : null,
            ),
          )
        ).filter((drive): drive is string => !!drive)
      : ['/'];
  return {
    path: root,
    parent: path.dirname(root) === root ? null : path.dirname(root),
    roots: drives,
    entries: values,
    truncated: shown.length > 2000,
  };
}
