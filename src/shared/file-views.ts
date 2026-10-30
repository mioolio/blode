export interface WorkspaceFileList {
  files: readonly { path: string }[];
  inventory?: { entries: readonly { path: string; kind: 'file' | 'directory' }[] };
}

/** Text snapshots and on-disk resources share the same tab namespace. */
export function openableFilePaths(workspace: WorkspaceFileList | null | undefined): string[] {
  if (!workspace) return [];
  return [
    ...new Set([
      ...workspace.files.map((file) => file.path),
      ...(workspace.inventory?.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path) ??
        []),
    ]),
  ];
}

export function workspaceFileView(
  workspace: WorkspaceFileList | null | undefined,
  path: string,
): 'text' | 'asset' | undefined {
  if (!workspace || !path) return;
  const text = workspace.files.some((file) => file.path === path);
  if (text) return 'text';
  if (text || workspace.inventory?.entries.some((entry) => entry.kind === 'file' && entry.path === path))
    return 'asset';
}
