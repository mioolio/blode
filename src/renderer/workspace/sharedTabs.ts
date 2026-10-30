import type { CollaborationSnapshot, WorkspaceTabCloseTransaction } from '../../shared/collaboration';
import { workspaceSurfaceKey, type WorkspaceSyncTarget } from '../../shared/workspace-surfaces';

type CloseFallback = () => boolean | void | Promise<boolean | void>;
interface SharedWorkspaceHandler {
  close(target: WorkspaceSyncTarget): Promise<boolean>;
  publish(target: WorkspaceSyncTarget, open: boolean): void;
}
let handler: SharedWorkspaceHandler | undefined;
export function registerSharedWorkspaceHandler(value: SharedWorkspaceHandler) {
  handler = value;
  return () => {
    if (handler === value) handler = undefined;
  };
}
/** All local UI tools enter collaboration through this dispatcher. */
export async function requestSharedTabClose(
  target: WorkspaceSyncTarget,
  fallback: CloseFallback,
): Promise<boolean> {
  if (handler) return handler.close(target);
  return (await fallback()) !== false;
}
export function publishSharedSurface(target: WorkspaceSyncTarget, open: boolean) {
  handler?.publish(target, open);
}

/** Coalesce UI state while offline and retry each latest intent in publication order. */
export class SharedSurfaceOutbox {
  private pending = new Map<string, { target: WorkspaceSyncTarget; open: boolean }>();
  private sending?: Promise<void>;
  private epoch = 0;
  get hasPending() {
    return this.pending.size > 0;
  }
  publish(target: WorkspaceSyncTarget, open: boolean) {
    const key = workspaceSurfaceKey(target);
    this.pending.delete(key);
    this.pending.set(key, { target, open });
  }
  reset() {
    this.epoch++;
    this.pending.clear();
    this.sending = undefined;
  }
  flush(send: (target: WorkspaceSyncTarget, open: boolean) => Promise<void>): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.pending.size) return Promise.resolve();
    const epoch = this.epoch;
    const operation = (async () => {
      while (epoch === this.epoch && this.pending.size) {
        const [key, item] = this.pending.entries().next().value!;
        await send(item.target, item.open);
        if (epoch !== this.epoch) return;
        if (this.pending.get(key) === item) this.pending.delete(key);
      }
    })();
    this.sending = operation;
    void operation
      .finally(() => {
        if (this.sending === operation) this.sending = undefined;
      })
      .catch(() => {});
    return operation;
  }
}

export interface SharedWorkspaceContext {
  projectRoot: string;
  session: string;
  peerId: string;
  actorToken: string;
}
interface ClientOptions {
  context(): SharedWorkspaceContext | undefined;
  request(
    context: SharedWorkspaceContext,
    target: WorkspaceSyncTarget,
    requestId: string,
  ): Promise<CollaborationSnapshot>;
  vote(
    context: SharedWorkspaceContext,
    requestId: string,
    decision: 'ready' | 'cancel',
    target: WorkspaceSyncTarget,
  ): Promise<CollaborationSnapshot>;
  prepare(target: WorkspaceSyncTarget, requestId: string): Promise<boolean>;
  owns?(target: WorkspaceSyncTarget): boolean;
  commit(target: WorkspaceSyncTarget, requestId: string): Promise<boolean | void> | boolean | void;
  abort(target: WorkspaceSyncTarget, requestId: string): void;
  surface(target: WorkspaceSyncTarget, open: boolean): void;
  failure(error: unknown): void;
  changed(): void;
}
interface LocalTransaction {
  tx: WorkspaceTabCloseTransaction;
  preparing?: Promise<void>;
  prepared: boolean;
  finished: boolean;
  result?: boolean;
  decision?: 'ready' | 'cancel';
}

/** Replays authoritative closures and acknowledges each owner's unsaved-file decision. */
export class SharedWorkspaceClient {
  private epoch = 0;
  private session = '';
  private revision = 0;
  private desiredRevision = 0;
  private pendingCommits = 0;
  private transactions = new Map<string, LocalTransaction>();
  private closures = new Set<string>();
  private surfaces = new Map<string, number>();
  private waiters = new Map<
    string,
    {
      requestId: string;
      transactionId?: string;
      promise: Promise<boolean>;
      resolve(value: boolean): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private readonly options: ClientOptions) {}
  get tabRevision() {
    return this.revision;
  }
  reset() {
    this.epoch++;
    for (const item of this.transactions.values())
      if (!item.finished) this.options.abort(item.tx.target, item.tx.requestId);
    this.transactions.clear();
    this.closures.clear();
    this.surfaces.clear();
    this.session = '';
    this.revision = 0;
    this.desiredRevision = 0;
    this.pendingCommits = 0;
    for (const item of this.waiters.values()) {
      clearTimeout(item.timer);
      item.resolve(false);
    }
    this.waiters.clear();
  }
  private acknowledge() {
    if (this.pendingCommits) return;
    this.revision = Math.max(this.revision, this.desiredRevision);
    this.closures.clear();
    for (const [id, item] of this.transactions) {
      if (this.transactions.size <= 512) break;
      if (item.finished && !this.waiters.has(workspaceSurfaceKey(item.tx.target)))
        this.transactions.delete(id);
    }
    const context = this.options.context();
    if (context)
      try {
        sessionStorage.setItem(
          `blode.tabs.revision:${context.projectRoot}:${context.session}`,
          String(this.revision),
        );
      } catch {}
  }
  private finish(target: WorkspaceSyncTarget, success: boolean, requestId: string) {
    const key = workspaceSurfaceKey(target),
      waiting = this.waiters.get(key);
    if (waiting && (waiting.requestId === requestId || waiting.transactionId === requestId)) {
      clearTimeout(waiting.timer);
      waiting.resolve(success);
      this.waiters.delete(key);
    }
  }
  private async commit(item: LocalTransaction, epoch: number) {
    if (item.finished) return;
    item.finished = true;
    if (!item.prepared && this.options.owns?.(item.tx.target) === false) {
      item.result = true;
      this.finish(item.tx.target, true, item.tx.requestId);
      return;
    }
    this.pendingCommits++;
    try {
      // A refreshed/offline page may hold a local draft that never voted in the transaction.
      const ready = item.prepared || (await this.options.prepare(item.tx.target, item.tx.requestId));
      if (epoch !== this.epoch) return;
      const success = ready && (await this.options.commit(item.tx.target, item.tx.requestId)) !== false;
      if (!success) this.options.abort(item.tx.target, item.tx.requestId);
      item.result = success;
      this.finish(item.tx.target, success, item.tx.requestId);
    } catch (error) {
      this.options.abort(item.tx.target, item.tx.requestId);
      this.options.failure(error);
      item.result = false;
      this.finish(item.tx.target, false, item.tx.requestId);
    } finally {
      if (epoch === this.epoch) {
        this.pendingCommits--;
        this.acknowledge();
        this.options.changed();
      }
    }
  }
  accept(snapshot: CollaborationSnapshot) {
    const context = this.options.context();
    if (!context || context.projectRoot !== snapshot.projectRoot || context.session !== snapshot.session)
      return;
    if (this.session && this.session !== snapshot.session) this.reset();
    if (!this.session) {
      try {
        const saved = Number(
          sessionStorage.getItem(`blode.tabs.revision:${context.projectRoot}:${context.session}`),
        );
        if (Number.isSafeInteger(saved) && saved >= 0 && saved <= (snapshot.tabRevision ?? 0))
          this.revision = saved;
      } catch {}
    }
    this.session = snapshot.session;
    this.desiredRevision = Math.max(this.desiredRevision, snapshot.tabRevision ?? 0);
    const epoch = this.epoch;
    const operations: Promise<unknown>[] = [];
    const reopened = (target: WorkspaceSyncTarget, revision: number) =>
      snapshot.surfaces?.some(
        (surface) =>
          surface.open &&
          surface.revision > revision &&
          workspaceSurfaceKey(surface.target) === workspaceSurfaceKey(target),
      );
    for (const tx of snapshot.tabCloses ?? []) {
      let item = this.transactions.get(tx.requestId);
      if (!item) {
        item = { tx, prepared: false, finished: false };
        this.transactions.set(tx.requestId, item);
      }
      if (item.tx.status !== 'preparing' && tx.status === 'preparing') continue;
      item.tx = tx;
      if (tx.status === 'aborted') {
        if (!item.finished) {
          item.finished = true;
          this.options.abort(tx.target, tx.requestId);
          if (tx.reason === 'changed' && tx.participants.includes(context.peerId))
            this.options.failure(new Error('error.tabCloseChanged'));
        }
        item.result = false;
        this.finish(tx.target, false, tx.requestId);
      } else if (tx.status === 'committed') {
        if (item.result !== undefined) this.finish(tx.target, item.result, tx.requestId);
        if (reopened(tx.target, tx.revision)) {
          item.finished = true;
          continue;
        }
        if (
          tx.revision <= this.revision &&
          !item.prepared &&
          !this.waiters.has(workspaceSurfaceKey(tx.target))
        ) {
          item.finished = true;
          continue;
        }
        this.closures.add(`${workspaceSurfaceKey(tx.target)}:${tx.revision}`);
        operations.push(this.commit(item, epoch));
      } else if (tx.participants.includes(context.peerId) && !item.preparing && !item.finished) {
        const current = item;
        current.preparing = (async () => {
          try {
            const ready = await this.options.prepare(tx.target, tx.requestId);
            if (epoch !== this.epoch || current.tx.status !== 'preparing' || current.finished) return;
            current.prepared = ready;
            current.decision = ready ? 'ready' : 'cancel';
            this.accept(
              await this.options.vote(context, tx.requestId, ready ? 'ready' : 'cancel', tx.target),
            );
          } catch (error) {
            if (epoch !== this.epoch) return;
            this.options.failure(error);
            this.options.abort(tx.target, tx.requestId);
            // Retry the same transaction after reconnect rather than leaving an unowned decision.
            current.preparing = undefined;
            void this.options
              .vote(context, tx.requestId, 'cancel', tx.target)
              .then((value) => this.accept(value))
              .catch(() => {});
          }
        })();
      }
    }
    for (const closed of snapshot.closedTabs ?? []) {
      const key = `${workspaceSurfaceKey(closed.target)}:${closed.revision}`;
      if (reopened(closed.target, closed.revision)) continue;
      if (closed.revision <= this.revision) continue;
      if (this.closures.has(key)) continue;
      this.closures.add(key);
      const item: LocalTransaction = {
        tx: {
          requestId: `replay:${closed.revision}:${workspaceSurfaceKey(closed.target)}`,
          target: closed.target,
          status: 'committed',
          revision: closed.revision,
          participants: [],
          ready: [],
          expiresAt: '',
        },
        prepared: false,
        finished: false,
      };
      operations.push(this.commit(item, epoch));
    }
    for (const surface of snapshot.surfaces ?? []) {
      const key = workspaceSurfaceKey(surface.target);
      if ((this.surfaces.get(key) ?? -1) >= surface.revision) continue;
      this.surfaces.set(key, surface.revision);
      this.options.surface(surface.target, surface.open);
    }
    this.acknowledge();
  }
  async close(target: WorkspaceSyncTarget): Promise<boolean> {
    const context = this.options.context();
    if (!context) return false;
    const key = workspaceSurfaceKey(target),
      existing = this.waiters.get(key);
    if (existing) {
      const answered = [...this.transactions.values()].some(
        (item) =>
          item.tx.status === 'preparing' &&
          item.decision !== undefined &&
          workspaceSurfaceKey(item.tx.target) === key,
      );
      if (!answered) return existing.promise;
      const completed = await existing.promise;
      if (completed) return true;
      const current = this.options.context();
      if (
        !current ||
        current.projectRoot !== context.projectRoot ||
        current.session !== context.session ||
        current.peerId !== context.peerId
      )
        return false;
      return this.close(target);
    }
    const requestId = crypto.randomUUID();
    let resolve!: (value: boolean) => void;
    const result = new Promise<boolean>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => {
      this.waiters.delete(key);
      resolve(false);
    }, 125_000);
    const waiting = {
      requestId,
      promise: result,
      resolve,
      timer,
      transactionId: undefined as string | undefined,
    };
    this.waiters.set(key, waiting);
    try {
      const snapshot = await this.options.request(context, target, requestId);
      const transaction =
        snapshot.tabCloses?.find((tx) => tx.requestId === requestId) ??
        snapshot.tabCloses?.find((tx) => tx.status === 'preparing' && workspaceSurfaceKey(tx.target) === key);
      if (transaction) waiting.transactionId = transaction.requestId;
      this.accept(snapshot);
    } catch (error) {
      this.options.failure(error);
      this.finish(target, false, requestId);
    }
    return result;
  }
}
