import type {
  CollaborationLeaveRequest,
  CollaborationPresenceInput,
  CollaborationSnapshot,
  WorkspaceTabCloseRequest,
} from '../shared/collaboration';
import type { CollaborationService } from './collaboration';

/** A native renderer has no SSE socket; its real window lifetime owns its presence leases. */
export class NativePresenceOwner {
  private generation = 0;
  private peers = new Map<string, CollaborationLeaveRequest>();
  private pending = new Map<string, number>();
  private attentive = true;
  private attentionEpoch = 0;
  private rendererEpoch = 0;
  constructor(
    private readonly service: Pick<CollaborationService, 'presence' | 'leave'> &
      Partial<Pick<CollaborationService, 'setAttention' | 'tabClose'>>,
  ) {}
  async setAttention(active: boolean): Promise<number> {
    if (this.attentive !== active) {
      this.attentive = active;
      this.attentionEpoch++;
    }
    const epoch = this.attentionEpoch;
    if (!active)
      await this.service.setAttention?.([...new Set([...this.peers.keys(), ...this.pending.keys()])]);
    return epoch;
  }
  async presence(input: CollaborationPresenceInput): Promise<CollaborationSnapshot> {
    const generation = this.generation;
    const epoch = this.attentionEpoch;
    const currentEpoch =
      epoch === 0
        ? input.attentionEpoch === undefined || input.attentionEpoch === 0
        : input.attentionEpoch === epoch;
    const canActivate = this.attentive && currentEpoch;
    const departedRenderer = (input.attentionEpoch ?? 0) < this.rendererEpoch;
    const peerId = input.identity.peerId;
    this.pending.set(peerId, (this.pending.get(peerId) ?? 0) + 1);
    let snapshot: CollaborationSnapshot;
    try {
      snapshot = await this.service.presence(
        canActivate
          ? input
          : {
              ...input,
              attention: 'inactive',
              // Blur retains ownership. Navigation retires it, including queued IPC from the former page.
              ...(!currentEpoch
                ? {
                    path: '',
                    openPaths: departedRenderer ? [] : undefined,
                    openTools: departedRenderer ? [] : undefined,
                    activeTool: undefined,
                  }
                : {}),
            },
        true,
      );
    } finally {
      const remaining = (this.pending.get(peerId) ?? 1) - 1;
      if (remaining > 0) this.pending.set(peerId, remaining);
      else this.pending.delete(peerId);
    }
    const lease: CollaborationLeaveRequest = {
      peerId: input.identity.peerId,
      actorToken: input.actorToken,
      projectRoot: input.projectRoot,
      session: snapshot.session,
      sequence: input.sequence,
    };
    if (generation !== this.generation) {
      await this.service.leave(lease, true);
      return snapshot;
    }
    const previous = this.peers.get(lease.peerId);
    if (!previous || previous.session !== lease.session || (lease.sequence ?? 0) >= (previous.sequence ?? 0))
      this.peers.set(lease.peerId, lease);
    if (this.peers.get(lease.peerId) === lease && (!this.attentive || epoch !== this.attentionEpoch)) {
      const inactive = await this.service.setAttention?.([lease.peerId]);
      if (inactive) snapshot = inactive;
    }
    return snapshot;
  }
  async leave(input: string | CollaborationLeaveRequest) {
    await this.service.leave(input, true);
    const request = typeof input === 'string' ? { peerId: input } : input,
      previous = this.peers.get(request.peerId);
    if (
      previous &&
      (!request.session || request.session === previous.session) &&
      (request.sequence === undefined || (request.sequence ?? 0) >= (previous.sequence ?? 0))
    )
      this.peers.delete(request.peerId);
  }
  async tabClose(input: WorkspaceTabCloseRequest): Promise<CollaborationSnapshot> {
    if (!this.service.tabClose) throw new Error('rpc.methodNotFound');
    const generation = this.generation;
    const snapshot = await this.service.tabClose(input, true);
    const lease: CollaborationLeaveRequest = {
      peerId: input.peerId,
      actorToken: input.actorToken,
      projectRoot: input.projectRoot,
      session: snapshot.session,
    };
    if (generation !== this.generation) await this.service.leave(lease, true);
    else if (!this.peers.has(input.peerId)) this.peers.set(input.peerId, lease);
    return snapshot;
  }
  async clear() {
    this.generation++;
    this.rendererEpoch = ++this.attentionEpoch;
    const peers = [...this.peers.values()];
    this.peers.clear();
    await Promise.allSettled(peers.map((peer) => this.service.leave(peer, true)));
  }
}
