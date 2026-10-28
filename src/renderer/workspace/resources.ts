import type { ProjectFile, ProjectInventory } from '../../shared/contracts';

/** Disk sizes are exact bytes; drafts replace only their corresponding saved source sizes. */
export function projectFootprint(
  inventory: ProjectInventory | undefined,
  files: ProjectFile[],
  drafts: Record<string, string>,
) {
  const sizes = new Map(
    inventory?.entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry.size]) ??
      [],
  );
  if (!inventory)
    for (const file of files) sizes.set(file.path, new TextEncoder().encode(file.content).length);
  for (const [path, content] of Object.entries(drafts))
    sizes.set(path, new TextEncoder().encode(content).length);
  const groups = new Map<string, { path: string; bytes: number; fileCount: number }>();
  let totalBytes = 0;
  for (const [path, size] of sizes) {
    totalBytes += size;
    const directory = path.includes('/') ? path.split('/')[0] : '/';
    const group = groups.get(directory) ?? { path: directory, bytes: 0, fileCount: 0 };
    group.bytes += size;
    group.fileCount++;
    groups.set(directory, group);
  }
  return {
    totalBytes,
    fileCount: sizes.size,
    directoryCount: inventory?.directoryCount ?? 0,
    groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes),
    truncated: inventory?.truncated ?? false,
  };
}
