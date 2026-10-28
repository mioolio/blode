/** Full workspace route names; changing one is an explicit navigation contract. */
export const workspaceRoutes = {
  editor: '/workspace/editor',
  layout: '/workspace/layout',
  automation: '/workspace/automation',
} as const;

export type WorkspaceRoute = { kind: 'editor'; file?: string } | { kind: 'layout' } | { kind: 'automation' };

const decodeFile = (segments: string) =>
  segments
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join('/');

export function parseWorkspaceRoute(hash = window.location.hash): WorkspaceRoute {
  const path = hash.replace(/^#/, '');
  for (const [kind, prefix] of Object.entries(workspaceRoutes)) {
    if (path === prefix) return { kind } as WorkspaceRoute;
    if (kind === 'editor' && path.startsWith(`${prefix}/`))
      return { kind: 'editor', file: decodeFile(path.slice(prefix.length + 1)) };
  }
  return { kind: 'editor' };
}

export function workspaceRouteHash(route: WorkspaceRoute): string {
  if (route.kind === 'editor') {
    const file = route.file
      ?.split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `#${workspaceRoutes.editor}${file ? `/${file}` : ''}`;
  }
  return `#${workspaceRoutes[route.kind]}`;
}
