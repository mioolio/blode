import type {
  CollaborationLeaveRequest,
  CollaborationPresenceInput,
  CollaborationSnapshot,
} from '../shared/collaboration';
import type { CollaborationService } from './collaboration';

/** A native renderer has no SSE socket; its real window lifetime owns its presence leases. */
export class NativePresenceOwner {
  private generation = 0;
  private peers = new Map<string, CollaborationLeaveRequest>();
  constructor(private readonly service: Pick<CollaborationService, 'presence' | 'leave'>) {}
  async presence(input: CollaborationPresenceInput): Promise<CollaborationSnapshot> {
    const generation = this.generation;
    const snapshot = await this.service.presence(input, true);
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
  async clear() {
    this.generation++;
    const peers = [...this.peers.values()];
    this.peers.clear();
    await Promise.allSettled(peers.map((peer) => this.service.leave(peer, true)));
  }
}
