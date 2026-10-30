import type { CollaborationToolTab } from '../../shared/collaboration';
import { openableFilePaths, workspaceFileView, type WorkspaceFileList } from '../../shared/file-views';

interface Viewport {
  /** Local-only tab context in which this editor reported its viewport. */
  ownerPath?: string;
  path: string;
  startLine: number;
  endLine: number;
  cursor?: { line: number; column: number };
}
interface State extends WorkspaceFileList {
  isWeb: boolean;
  showHome: boolean;
  view: string;
  activePath: string;
  openFiles: readonly string[];
  openTools: readonly CollaborationToolTab[];
  files: readonly { path: string }[];
}
export interface LocalTabPresence extends Viewport {
  openPaths: string[];
  openTools: CollaborationToolTab[];
  activeTool?: CollaborationToolTab;
  clientKind: 'desktop' | 'web';
}

/** Advertise locally owned tabs only. Shared suggestions must never echo back as new opens. */
export function localTabPresence(
  owner: State,
  viewport: Viewport | undefined,
  closingFiles: ReadonlySet<string>,
  closingTools: ReadonlySet<string>,
): LocalTabPresence | null {
  if (owner.showHome) return null;
  const allowed = new Set(openableFilePaths(owner));
  const openPaths = [...new Set(owner.openFiles)].filter(
    (path) => allowed.has(path) && !closingFiles.has(path),
  );
  const activeTool: CollaborationToolTab | undefined =
    (owner.view === 'layout' || owner.view === 'ai') && !closingTools.has(owner.view)
      ? owner.view
      : undefined;
  const openTools = [
    ...new Set<CollaborationToolTab>([...owner.openTools, ...(activeTool ? [activeTool] : [])]),
  ].filter((tool) => !closingTools.has(tool));
  if (!openPaths.length && !openTools.length) return null;
  const asset = workspaceFileView(owner, owner.activePath) === 'asset';
  let selected: Viewport | undefined;
  if (owner.view === 'code') {
    if (asset) {
      if (openPaths.includes(owner.activePath))
        selected = { path: owner.activePath, startLine: 1, endLine: 1 };
    } else if (owner.isWeb) {
      selected =
        viewport &&
        (viewport.ownerPath ?? viewport.path) === owner.activePath &&
        openPaths.includes(viewport.path)
          ? viewport
          : openPaths.includes(owner.activePath)
            ? { path: owner.activePath, startLine: 1, endLine: 1 }
            : undefined;
    }
  }
  return {
    path: selected?.path ?? '',
    startLine: selected?.startLine ?? 1,
    endLine: selected?.endLine ?? 1,
    ...(selected?.cursor ? { cursor: selected.cursor } : {}),
    openPaths: selected
      ? [selected.path, ...openPaths.filter((path) => path !== selected.path)].slice(0, 256)
      : openPaths.slice(0, 256),
    openTools,
    ...(activeTool ? { activeTool } : {}),
    clientKind: owner.isWeb ? 'web' : 'desktop',
  };
}
