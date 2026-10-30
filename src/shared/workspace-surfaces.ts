export const workspaceTools = ['layout', 'ai'] as const;
export const workspaceConsoleTabs = [
  'output',
  'serial',
  'problems',
  'warnings',
  'terminal',
  'resources',
] as const;
export type WorkspaceToolId = (typeof workspaceTools)[number];
export type WorkspaceConsoleTabId = (typeof workspaceConsoleTabs)[number] | `plugin:${string}`;
export type WorkspaceSurfaceKind = 'file' | 'tool' | 'console' | 'panel';
export interface WorkspaceSyncTarget {
  kind: WorkspaceSurfaceKind;
  id: string;
}
export interface WorkspaceSurfaceDefinition {
  kind: Exclude<WorkspaceSurfaceKind, 'file'>;
  id: string;
}
/** All observable workspace surfaces are registered once for local and remote clients. */
export const workspaceSurfaces: readonly WorkspaceSurfaceDefinition[] = [
  ...workspaceTools.map((id) => ({ kind: 'tool' as const, id })),
  ...workspaceConsoleTabs.map((id) => ({ kind: 'console' as const, id })),
  { kind: 'panel', id: 'console' },
  { kind: 'panel', id: 'device' },
  { kind: 'panel', id: 'runtime' },
];
export function workspaceSurfaceKey(target: WorkspaceSyncTarget): string {
  return `${target.kind}:${target.id}`;
}
export function registeredWorkspaceSurface(target: WorkspaceSyncTarget): boolean {
  if (target.kind === 'file') return !!target.id && target.id.length <= 1024;
  return (
    workspaceSurfaces.some((surface) => surface.kind === target.kind && surface.id === target.id) ||
    ((target.kind === 'tool' || target.kind === 'console') &&
      /^plugin:[A-Za-z][A-Za-z0-9_-]{0,79}(?:[/:][A-Za-z][A-Za-z0-9_-]{0,79})?$/.test(target.id))
  );
}
