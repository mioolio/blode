import type { CollaborationPeer, WorkspaceTabCloseTransaction } from '../shared/collaboration';
import { workspaceSurfaceKey, type WorkspaceSyncTarget } from '../shared/workspace-surfaces';

/** Workspace-scoped authority. A close becomes visible only after every owner agrees. */
export class SharedTabAuthority {
  private revision = 0;
  private transactions = new Map<string, WorkspaceTabCloseTransaction>();
  private closures = new Map<string, { target: WorkspaceSyncTarget; revision: number }>();
  private surfaces = new Map<string, { target: WorkspaceSyncTarget; open: boolean; revision: number }>();
  reset() {
    this.revision = 0;
    this.transactions.clear();
    this.closures.clear();
    this.surfaces.clear();
  }
  snapshot() {
    return structuredClone({
      tabRevision: this.revision,
      closedTabs: [...this.closures.values()],
      tabCloses: [...this.transactions.values()],
      surfaces: [...this.surfaces.values()].sort((a, b) => a.revision - b.revision),
    });
  }
  accepts(target: WorkspaceSyncTarget, revision = 0) {
    return (this.closures.get(workspaceSurfaceKey(target))?.revision ?? 0) <= revision;
  }
  locked(peerId: string, path: string) {
    return [...this.transactions.values()].some(
      (tx) =>
        tx.status === 'preparing' &&
        tx.target.kind === 'file' &&
        tx.target.id === path &&
        tx.ready.includes(peerId),
    );
  }
  owns(peer: CollaborationPeer, target: WorkspaceSyncTarget) {
    if (target.kind === 'file') return peer.path === target.id || !!peer.openPaths?.includes(target.id);
    if (target.kind === 'tool')
      return peer.activeTool === target.id || !!peer.openTools?.includes(target.id as never);
    return true;
  }
  joined(peer: CollaborationPeer) {
    for (const tx of this.transactions.values())
      if (tx.status === 'preparing' && this.owns(peer, tx.target) && !tx.participants.includes(peer.peerId))
        tx.participants.push(peer.peerId);
  }
  request(
    requestId: string,
    target: WorkspaceSyncTarget,
    initiator: string,
    peers: CollaborationPeer[],
    now: number,
  ) {
    this.expire(now);
    const old = this.transactions.get(requestId);
    if (old) {
      if (
        workspaceSurfaceKey(old.target) !== workspaceSurfaceKey(target) ||
        !old.participants.includes(initiator)
      )
        throw new Error('rpc.invalidParams');
      return old;
    }
    const pending = [...this.transactions.values()].find(
      (tx) => tx.status === 'preparing' && workspaceSurfaceKey(tx.target) === workspaceSurfaceKey(target),
    );
    if (pending) {
      if (!pending.participants.includes(initiator)) pending.participants.push(initiator);
      return pending;
    }
    if ([...this.transactions.values()].filter((tx) => tx.status === 'preparing').length >= 32)
      throw new Error('rpc.limitExceeded');
    const tx: WorkspaceTabCloseTransaction = {
      requestId,
      target: structuredClone(target),
      status: 'preparing',
      revision: this.revision,
      participants: [
        ...new Set([
          initiator,
          ...peers.filter((peer) => this.owns(peer, target)).map((peer) => peer.peerId),
        ]),
      ],
      ready: [],
      expiresAt: new Date(now + 120_000).toISOString(),
    };
    this.transactions.set(requestId, tx);
    while (this.transactions.size > 256) {
      const expired = [...this.transactions].find(([, entry]) => entry.status !== 'preparing');
      if (!expired) break;
      this.transactions.delete(expired[0]);
    }
    return tx;
  }
  vote(
    requestId: string,
    peerId: string,
    decision: 'ready' | 'cancel',
    now: number,
    documentRevision?: number,
    currentRevision?: number,
  ) {
    this.expire(now);
    const tx = this.transactions.get(requestId);
    if (!tx || !tx.participants.includes(peerId)) throw new Error('rpc.invalidParams');
    if (tx.status !== 'preparing') return tx;
    const changed =
      currentRevision !== undefined &&
      (documentRevision !== currentRevision ||
        (tx.documentRevision !== undefined && tx.documentRevision !== currentRevision));
    if (decision === 'cancel' || changed) {
      tx.status = 'aborted';
      if (decision !== 'cancel' && changed) tx.reason = 'changed';
    } else {
      if (currentRevision !== undefined) tx.documentRevision = currentRevision;
      if (!tx.ready.includes(peerId)) tx.ready.push(peerId);
      if (tx.participants.every((peer) => tx.ready.includes(peer))) {
        tx.status = 'committed';
        tx.revision = ++this.revision;
        this.closures.set(workspaceSurfaceKey(tx.target), { target: tx.target, revision: tx.revision });
        if (tx.target.kind !== 'file')
          this.surfaces.set(workspaceSurfaceKey(tx.target), {
            target: tx.target,
            open: false,
            revision: tx.revision,
          });
      }
    }
    return tx;
  }
  transaction(requestId: string) {
    return this.transactions.get(requestId);
  }
  update(target: WorkspaceSyncTarget, open: boolean, ifAbsent = false) {
    const key = workspaceSurfaceKey(target),
      old = this.surfaces.get(key);
    if (
      ifAbsent &&
      (old ||
        (target.kind === 'console' &&
          [...this.surfaces.values()].some((surface) => surface.target.kind === 'console')))
    )
      return;
    if (old?.open === open && target.kind !== 'console') return;
    this.surfaces.set(key, { target, open, revision: ++this.revision });
  }
  departed(peerId: string) {
    let changed = false;
    for (const tx of this.transactions.values())
      if (tx.status === 'preparing' && tx.participants.includes(peerId)) {
        tx.status = 'aborted';
        tx.reason = 'departed';
        changed = true;
      }
    return changed;
  }
  expire(now: number) {
    let changed = false;
    for (const tx of this.transactions.values())
      if (tx.status === 'preparing' && Date.parse(tx.expiresAt) <= now) {
        tx.status = 'aborted';
        tx.reason = 'timeout';
        changed = true;
      }
    return changed;
  }
}
