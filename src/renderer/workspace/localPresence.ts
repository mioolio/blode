import type { CollaborationToolTab } from '../../shared/collaboration';

interface Viewport {
  path: string;
  startLine: number;
  endLine: number;
  cursor?: { line: number; column: number };
}
interface State {
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
  const allowed = new Set(owner.files.map((file) => file.path));
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
  const selected =
    owner.isWeb && owner.view === 'code'
      ? viewport && openPaths.includes(viewport.path)
        ? viewport
        : openPaths.includes(owner.activePath)
          ? { path: owner.activePath, startLine: 1, endLine: 1 }
          : undefined
      : undefined;
  return {
    ...(selected ?? { path: '', startLine: 1, endLine: 1 }),
    openPaths: selected
      ? [selected.path, ...openPaths.filter((path) => path !== selected.path)].slice(0, 256)
      : openPaths.slice(0, 256),
    openTools,
    ...(activeTool ? { activeTool } : {}),
    clientKind: owner.isWeb ? 'web' : 'desktop',
  };
}
