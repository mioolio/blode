import type { CollaborationPeer, CollaborationToolTab } from '../../shared/collaboration';

export interface FilePeerView extends CollaborationPeer {
  viewing: boolean;
}
/** A user's editing status and line range describe the active file, never every open tab. */
export function peersForFile(peers: readonly CollaborationPeer[], path: string): FilePeerView[] {
  const users = new Map<string, FilePeerView>();
  for (const peer of peers) {
    if (peer.attention === 'inactive') continue;
    if (peer.path !== path && !peer.openPaths?.includes(path)) continue;
    const candidate = { ...peer, viewing: peer.path === path, editing: peer.path === path && peer.editing };
    const previous = users.get(peer.userId);
    const rank = (value: FilePeerView) => Number(value.viewing) + Number(value.editing);
    if (
      !previous ||
      rank(candidate) > rank(previous) ||
      (rank(candidate) === rank(previous) && candidate.seenAt > previous.seenAt)
    )
      users.set(peer.userId, candidate);
  }
  return [...users.values()];
}

export function peersForTool(
  peers: readonly CollaborationPeer[],
  tool: CollaborationToolTab,
): FilePeerView[] {
  const users = new Map<string, FilePeerView>();
  for (const peer of peers) {
    if (peer.attention === 'inactive') continue;
    if (peer.activeTool !== tool && !peer.openTools?.includes(tool)) continue;
    const candidate = { ...peer, viewing: peer.activeTool === tool, editing: false };
    const previous = users.get(peer.userId);
    if (
      !previous ||
      (!previous.viewing && candidate.viewing) ||
      (previous.viewing === candidate.viewing && candidate.seenAt > previous.seenAt)
    )
      users.set(peer.userId, candidate);
  }
  return [...users.values()];
}
