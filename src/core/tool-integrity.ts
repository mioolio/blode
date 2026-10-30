import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RuntimeHost } from '../../extensions/runtime';
/** Normalize only the newly installed tree; preserve owners and access-control entries. */
export async function repairInstalledToolIntegrity(
  directory: string,
  stageRoot: string,
  runner: RuntimeHost['runCommand'],
  signal?: AbortSignal,
) {
  if (process.platform !== 'win32') return;
  const root = await fs.realpath(stageRoot),
    target = await fs.realpath(directory),
    relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('error.toolPackageExtract');
  const inspect = async (current: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) throw new Error('error.toolPackageExtract');
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (!entry.isFile()) throw new Error('error.toolPackageExtract');
    }
  };
  await inspect(target);
  const result = await runner(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [target, '/setintegritylevel', '(OI)(CI)M', '/T', '/L'],
    { signal, timeout: 120000 },
  );
  if (result.code !== 0) throw new Error('error.toolPackageExtract');
}
