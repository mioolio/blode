import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  COLLABORATION_COLORS,
  type CollaborationChange,
  type CollaborationDocument,
  type CollaborationEditRequest,
  type CollaborationEditResult,
  type CollaborationEvent,
  type CollaborationPeer,
  type CollaborationPresenceInput,
  type CollaborationSaveRequest,
  type CollaborationResolveRequest,
  type CollaborationSnapshot,
  type CollaborationUndoRequest,
  type CollaborationLeaveRequest,
  type WorkspaceTabCloseRequest,
  type WorkspaceTabCloseVote,
  type WorkspaceSurfaceUpdate,
  type WorkspaceSurfaceBootstrap,
} from '../shared/collaboration';
import { SharedTabAuthority } from './shared-tab-authority';
import { collaborationSchemas } from './collaboration-schemas';
import { inverseChanges, planUndo, recordUndo, type UndoGroup } from '../shared/selective-undo';
import { openableFilePaths } from '../shared/file-views';
import type { WorkspaceFileList } from '../shared/file-views';

const MAX_TEXT = 1_000_000;
const MAX_DOCUMENTS = 128;
const MAX_TOTAL_TEXT = 8_000_000;
const MAX_HISTORY = 256;
const PEER_TTL = 45_000;
const INACTIVE_TTL = 24 * 60 * 60 * 1000;
interface HistoryEntry {
  revision: number;
  changes: CollaborationChange[];
  beforeLength: number;
}
interface DocumentState {
  value: CollaborationDocument;
  diskContent: string;
  externalContent?: string;
  history: HistoryEntry[];
  undo: UndoGroup[];
}
export interface CollaborationWorkspace extends WorkspaceFileList {
  projectRoot: string;
  files: { path: string; content: string }[];
}
export interface CollaborationOptions {
  workspace(): Promise<CollaborationWorkspace>;
  /** Bypass the file-index cache before any write or explicit disk-conflict resolution. */
  freshWorkspace?(): Promise<CollaborationWorkspace>;
  /** The original core saveFile implementation, before routing through this service. */
  saveFile?(path: string, content: string): Promise<void>;
  publish(event: CollaborationEvent): void;
  now?: () => number;
}

export function normalizeCollaborationPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.length > 1024 ||
    /[\x00-\x1f:]/.test(normalized) ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new Error('error.invalidPath');
  return normalized;
}

/** Apply one batch expressed in the same pre-edit document coordinate space. */
export function applyCollaborationChanges(content: string, changes: CollaborationChange[]): string {
  let result = content;
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index];
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  }
  return result;
}

/** Rebase only independent edits; ambiguous overlapping replacements are never guessed. */
export function transformCollaborationChanges(
  incoming: CollaborationChange[],
  applied: CollaborationChange[],
): CollaborationChange[] | null {
  const transformed: CollaborationChange[] = [];
  for (const next of incoming) {
    const insertion = next.start === next.end;
    let startDelta = 0,
      endDelta = 0;
    for (const prior of applied) {
      const priorInsertion = prior.start === prior.end;
      const overlap = insertion
        ? prior.start < next.start && next.start < prior.end
        : priorInsertion
          ? next.start < prior.start && prior.start < next.end
          : next.start < prior.end && prior.start < next.end;
      if (overlap) return null;
      const delta = prior.text.length - (prior.end - prior.start);
      if (prior.end <= next.start) startDelta += delta;
      if (prior.end < next.end || (prior.end === next.end && (!priorInsertion || insertion)))
        endDelta += delta;
    }
    transformed.push({
      start: next.start + startDelta,
      end: next.end + (insertion ? startDelta : endDelta),
      text: next.text,
    });
  }
  return transformed;
}

/** One serialized authority for shared unsaved text, independent from renderer lifetimes. */
export class CollaborationService {
  private readonlySources?: (projectRoot: string) => readonly string[];
  private readonlyViewable = new Set<string>();
  setReadonlySources(provider: (projectRoot: string) => readonly string[]) {
    this.readonlySources = provider;
  }
  private projectRoot = '';
  private session = randomUUID();
  private files = new Map<string, string>();
  private viewableFiles = new Set<string>();
  private documents = new Map<string, DocumentState>();
  private peers = new Map<string, CollaborationPeer>();
  private colors = new Map<string, string>();
  private requests = new Map<string, { signature: string; result: CollaborationEditResult }>();
  private actors = new Map<string, string>();
  private presenceOrder = new Map<string, { sequence: number; departed: boolean }>();
  private presenceRevision = 0;
  private tabs = new SharedTabAuthority();
  private documentRevisions = new Map<string, number>();
  private shutdownPrepared = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: CollaborationOptions) {
    this.timer = setInterval(() => this.expirePeers(), 15_000);
    this.timer.unref();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }
  private publish(event: CollaborationEvent) {
    this.options.publish(structuredClone(event));
  }
  private requireWritable() {
    if (this.shutdownPrepared) throw new Error('error.shutdownInProgress');
  }
  private snapshot(): CollaborationSnapshot {
    return {
      projectRoot: this.projectRoot,
      session: this.session,
      presenceRevision: this.presenceRevision,
      ...this.tabs.snapshot(),
      peers: [...this.peers.values()].map((peer) => structuredClone(peer)),
      documents: [...this.documents.values()].map(({ value }) => ({
        path: value.path,
        revision: value.revision,
        dirty: value.dirty,
      })),
    };
  }
  private expirePeers() {
    let changed = this.tabs.expire(this.now());
    for (const [id, peer] of this.peers) {
      const path = this.viewableFiles.has(peer.path) ? peer.path : '';
      const openPaths = (peer.openPaths ?? (path ? [path] : [])).filter((entry) =>
        this.viewableFiles.has(entry),
      );
      const text = !!path && (this.files.has(path) || this.readonlyViewable.has(path));
      const clearRange =
        !text && (peer.startLine !== 1 || peer.endLine !== 1 || !!peer.cursor || peer.editing);
      if (
        (!path && !openPaths.length && !peer.openTools?.length) ||
        Date.parse(peer.seenAt) < this.now() - (peer.attention === 'inactive' ? INACTIVE_TTL : PEER_TTL)
      ) {
        this.peers.delete(id);
        this.tabs.departed(id);
        changed = true;
      } else if (path !== peer.path || openPaths.length !== peer.openPaths?.length || clearRange) {
        this.peers.set(id, {
          ...peer,
          path,
          openPaths,
          ...(text ? {} : { startLine: 1, endLine: 1, cursor: undefined, editing: false }),
        });
        changed = true;
      }
    }
    if (changed) {
      this.presenceRevision++;
      this.publish({ type: 'presence', snapshot: this.snapshot() });
    }
  }
  private async sync(fresh = false) {
    const workspace = await (fresh && this.options.freshWorkspace
      ? this.options.freshWorkspace()
      : this.options.workspace());
    const files = new Map(
      workspace.files.map((file) => [normalizeCollaborationPath(file.path), file.content]),
    );
    const viewable = new Set(openableFilePaths(workspace).map(normalizeCollaborationPath));
    this.readonlyViewable = new Set(
      (this.readonlySources?.(workspace.projectRoot) ?? []).map(normalizeCollaborationPath),
    );
    for (const file of this.readonlyViewable) viewable.add(file);
    if (workspace.projectRoot !== this.projectRoot) {
      this.projectRoot = workspace.projectRoot;
      this.session = randomUUID();
      this.presenceRevision++;
      this.documents.clear();
      this.peers.clear();
      this.requests.clear();
      this.colors.clear();
      this.actors.clear();
      this.presenceOrder.clear();
      this.documentRevisions.clear();
      this.tabs.reset();
      this.files = files;
      this.viewableFiles = viewable;
      this.publish({ type: 'workspace', snapshot: this.snapshot() });
      return;
    }
    this.files = files;
    this.viewableFiles = viewable;
    for (const [path, doc] of this.documents) {
      const content = files.get(path);
      if (content === undefined) {
        if (!doc.value.dirty) {
          this.documentRevisions.set(path, doc.value.revision + 1);
          this.documents.delete(path);
        }
        continue;
      }
      if (content === doc.diskContent) {
        // An ordinary workspace snapshot can still be from before an external write.
        if (fresh) doc.externalContent = undefined;
        continue;
      }
      if (doc.value.dirty) {
        if (doc.externalContent !== content) {
          doc.externalContent = content;
          this.publish({
            type: 'conflict',
            document: doc.value,
            reason: 'diskChanged',
            diskContent: content,
          });
        }
      } else {
        const previousRevision = doc.value.revision;
        const changes = [{ start: 0, end: doc.value.content.length, text: content }];
        this.changeDocument(doc, changes);
        doc.diskContent = content;
        doc.value.dirty = false;
        this.publish({ type: 'document', document: doc.value, previousRevision, changes });
      }
    }
    this.expirePeers();
  }
  private requireProject(projectRoot: string, session?: string) {
    if (
      !this.projectRoot ||
      projectRoot !== this.projectRoot ||
      (session !== undefined && session !== this.session)
    )
      throw new Error('error.collaborationProjectChanged');
  }
  private document(path: string): DocumentState {
    const normalized = normalizeCollaborationPath(path);
    const content = this.files.get(normalized);
    if (content === undefined) throw new Error('rpc.fileNotFound');
    let doc = this.documents.get(normalized);
    if (!doc) {
      // Reading hundreds of tabs must not pin every immutable copy forever. Never evict
      // drafts or undo/history. Active viewports are retained; passive read-only tabs
      // reopen with a newer revision, so a stale edit cannot target a different base.
      const active = new Set([...this.peers.values()].map((peer) => peer.path));
      const opened = new Set([...this.peers.values()].flatMap((peer) => peer.openPaths ?? [peer.path]));
      const disposable = [...this.documents.entries()]
        .filter(
          ([file, item]) =>
            file !== normalized &&
            !item.value.dirty &&
            !item.history.length &&
            !item.undo.length &&
            !active.has(file),
        )
        .sort(([a], [b]) => Number(opened.has(a)) - Number(opened.has(b)));
      while (
        (this.documents.size >= MAX_DOCUMENTS || this.totalText() + content.length > MAX_TOTAL_TEXT) &&
        disposable.length
      ) {
        const [file, item] = disposable.shift()!;
        this.documentRevisions.set(file, item.value.revision + 1);
        this.documents.delete(file);
      }
      if (
        this.documents.size >= MAX_DOCUMENTS ||
        content.length > MAX_TEXT ||
        this.totalText() + content.length > MAX_TOTAL_TEXT
      )
        throw new Error('rpc.limitExceeded');
      doc = {
        value: {
          projectRoot: this.projectRoot,
          session: this.session,
          path: normalized,
          revision: this.documentRevisions.get(normalized) ?? 0,
          content,
          dirty: false,
        },
        diskContent: content,
        history: [],
        undo: [],
      };
      this.documents.set(normalized, doc);
    }
    return doc;
  }
  private totalText() {
    return [...this.documents.values()].reduce((sum, doc) => sum + doc.value.content.length, 0);
  }
  private changeDocument(doc: DocumentState, changes: CollaborationChange[], author?: string) {
    const before = doc.value.content;
    const beforeLength = doc.value.content.length;
    doc.value.content = applyCollaborationChanges(doc.value.content, changes);
    doc.value.revision += 1;
    doc.value.dirty = doc.value.content !== doc.diskContent;
    doc.history.push({ revision: doc.value.revision, changes: structuredClone(changes), beforeLength });
    if (author) recordUndo(doc.undo, before, changes, doc.value.revision, author, this.now());
    let undoText = [...this.documents.values()].reduce(
      (sum, entry) =>
        sum +
        entry.undo.reduce(
          (n, group) =>
            n +
            group.changes.reduce((chars, change) => chars + change.text.length, 0) +
            (group.redo?.changes.reduce((chars, change) => chars + change.text.length, 0) ?? 0),
          0,
        ),
      0,
    );
    for (const entry of this.documents.values())
      while (undoText > 16_000_000 && entry.undo.length > 1) {
        const group = entry.undo.shift()!;
        undoText -=
          group.changes.reduce((n, change) => n + change.text.length, 0) +
          (group.redo?.changes.reduce((n, change) => n + change.text.length, 0) ?? 0);
      }
    while (
      doc.history.length > MAX_HISTORY ||
      (doc.history.length > 1 &&
        doc.history.reduce(
          (sum, item) => sum + item.changes.reduce((count, change) => count + change.text.length, 0),
          0,
        ) > 2_000_000)
    )
      doc.history.shift();
    // Many documents with large replacements must not accumulate unbounded history.
    let totalHistory = [...this.documents.values()].reduce(
      (sum, item) =>
        sum +
        item.history.reduce(
          (count, entry) => count + entry.changes.reduce((chars, change) => chars + change.text.length, 0),
          0,
        ),
      0,
    );
    for (const item of this.documents.values())
      while (totalHistory > 16_000_000 && item.history.length > 1) {
        totalHistory -= item.history.shift()!.changes.reduce((sum, change) => sum + change.text.length, 0);
      }
  }
  state() {
    return this.exclusive(async () => {
      await this.sync();
      return this.snapshot();
    });
  }
  tabClose(input: WorkspaceTabCloseRequest, trustedLocal = true) {
    return this.exclusive(async () => {
      this.requireWritable();
      const request = collaborationSchemas.tabClose.parse(input);
      await this.sync();
      this.requireProject(request.projectRoot, request.session);
      this.actor(request.peerId, request.actorToken, trustedLocal);
      const target =
        request.target.kind === 'file'
          ? { kind: 'file' as const, id: normalizeCollaborationPath(request.target.id) }
          : request.target;
      this.tabs.request(request.requestId, target, request.peerId, [...this.peers.values()], this.now());
      this.presenceRevision++;
      const snapshot = this.snapshot();
      this.publish({ type: 'presence', snapshot });
      return snapshot;
    });
  }
  tabCloseVote(input: WorkspaceTabCloseVote, trustedLocal = true) {
    return this.exclusive(async () => {
      this.requireWritable();
      const request = collaborationSchemas.tabCloseVote.parse(input);
      await this.sync(true);
      this.requireProject(request.projectRoot, request.session);
      this.actor(request.peerId, request.actorToken, trustedLocal);
      const pending = this.tabs.transaction(request.requestId);
      const wasPreparing = pending?.status === 'preparing';
      const doc = pending?.target.kind === 'file' ? this.documents.get(pending.target.id) : undefined;
      const tx = this.tabs.vote(
        request.requestId,
        request.peerId,
        doc?.externalContent !== undefined ? 'cancel' : request.decision,
        this.now(),
        request.documentRevision,
        doc?.value.revision,
      );
      if (wasPreparing && doc?.externalContent !== undefined && tx.status === 'aborted')
        tx.reason = 'changed';
      // Every owner confirmed the same shared version. Reopening starts at the saved disk text.
      // Do not broadcast a replacement document while clients still hold their close snapshots.
      if (wasPreparing && tx.status === 'committed' && doc) {
        this.documentRevisions.set(doc.value.path, doc.value.revision + 1);
        this.documents.delete(doc.value.path);
      }
      if (wasPreparing && tx.status === 'committed')
        for (const [id, peer] of this.peers) {
          if (tx.target.kind === 'file') {
            const path = peer.path === tx.target.id ? '' : peer.path;
            this.peers.set(id, {
              ...peer,
              path,
              openPaths: peer.openPaths?.filter((path) => path !== tx.target.id),
              ...(path ? {} : { startLine: 1, endLine: 1, cursor: undefined, editing: false }),
            });
          } else if (tx.target.kind === 'tool')
            this.peers.set(id, {
              ...peer,
              openTools: peer.openTools?.filter((tool) => tool !== tx.target.id),
              activeTool: peer.activeTool === tx.target.id ? undefined : peer.activeTool,
            });
        }
      this.presenceRevision++;
      const snapshot = this.snapshot();
      this.publish({ type: 'presence', snapshot });
      return snapshot;
    });
  }
  surfaceUpdate(input: WorkspaceSurfaceUpdate, trustedLocal = true) {
    return this.exclusive(async () => {
      const request = collaborationSchemas.surfaceUpdate.parse(input);
      await this.sync();
      this.requireProject(request.projectRoot, request.session);
      this.actor(request.peerId, request.actorToken, trustedLocal);
      this.tabs.update(request.target, request.open);
      this.presenceRevision++;
      const snapshot = this.snapshot();
      this.publish({ type: 'presence', snapshot });
      return snapshot;
    });
  }
  surfaceBootstrap(input: WorkspaceSurfaceBootstrap, trustedLocal = true) {
    return this.exclusive(async () => {
      const request = collaborationSchemas.surfaceBootstrap.parse(input);
      await this.sync();
      this.requireProject(request.projectRoot, request.session);
      this.actor(request.peerId, request.actorToken, trustedLocal);
      for (const surface of request.surfaces) this.tabs.update(surface.target, surface.open, true);
      this.presenceRevision++;
      const snapshot = this.snapshot();
      this.publish({ type: 'presence', snapshot });
      return snapshot;
    });
  }
  open(projectRoot: string, path: string) {
    return this.exclusive(async () => {
      await this.sync();
      this.requireProject(projectRoot);
      return structuredClone(this.document(path).value);
    });
  }
  private actor(peerId: string, token: string | undefined, trustedLocal: boolean) {
    if (!token && !trustedLocal) throw new Error('error.collaborationActorRequired');
    const signature = token ? createHash('sha256').update(token).digest('hex') : '$trusted';
    const existing = this.actors.get(peerId);
    if (token && existing && existing !== signature) throw new Error('error.collaborationActorMismatch');
    if (!existing) {
      if (this.actors.size >= 4096) throw new Error('rpc.limitExceeded');
      this.actors.set(peerId, signature);
    }
  }
  private remember(key: string, signature: string, result: CollaborationEditResult) {
    this.requests.set(key, { signature, result: structuredClone(result) });
    let text = [...this.requests.values()].reduce(
      (sum, entry) => sum + entry.result.document.content.length + (entry.result.diskContent?.length ?? 0),
      0,
    );
    while (this.requests.size > 128 || (text > 8_000_000 && this.requests.size > 1)) {
      const oldest = this.requests.keys().next().value!,
        entry = this.requests.get(oldest)!;
      text -= entry.result.document.content.length + (entry.result.diskContent?.length ?? 0);
      this.requests.delete(oldest);
    }
  }
  presence(input: CollaborationPresenceInput, trustedLocal = true) {
    return this.exclusive(async () => {
      const parsed = collaborationSchemas.presence.parse(input);
      await this.sync();
      this.requireProject(parsed.projectRoot, parsed.session);
      this.actor(parsed.identity.peerId, parsed.actorToken, trustedLocal);
      const previous = this.presenceOrder.get(parsed.identity.peerId);
      if (previous && (parsed.sequence === undefined || parsed.sequence <= previous.sequence))
        return this.snapshot();
      if (parsed.sequence !== undefined)
        this.presenceOrder.set(parsed.identity.peerId, { sequence: parsed.sequence, departed: false });
      const inactive = parsed.attention === 'inactive';
      const existing = this.peers.get(parsed.identity.peerId);
      const selectedPath =
        inactive || parsed.activeTool ? '' : parsed.path ? normalizeCollaborationPath(parsed.path) : '';
      // Desktop code stays private; resource previews carry no code coordinates.
      let path =
        parsed.clientKind === 'desktop' &&
        (this.files.has(selectedPath) || this.readonlyViewable.has(selectedPath))
          ? ''
          : selectedPath;
      if (path && !this.viewableFiles.has(path)) throw new Error('rpc.fileNotFound');
      if (path && !this.tabs.accepts({ kind: 'file', id: path }, parsed.tabRevision)) path = '';
      const text = !!path && (this.files.has(path) || this.readonlyViewable.has(path));
      const openPaths = [
        ...new Set([
          ...(path ? [path] : []),
          ...(parsed.openPaths ?? (inactive ? existing?.openPaths : []) ?? []),
        ]),
      ]
        .map(normalizeCollaborationPath)
        .filter(
          (entry) =>
            this.viewableFiles.has(entry) &&
            this.tabs.accepts({ kind: 'file', id: entry }, parsed.tabRevision),
        )
        .slice(0, 256);
      const openTools = [
        ...new Set([
          ...(parsed.openTools ?? (inactive ? existing?.openTools : []) ?? []),
          ...(!inactive && parsed.activeTool ? [parsed.activeTool] : []),
        ]),
      ];
      const allowedTools = openTools.filter((id) =>
        this.tabs.accepts({ kind: 'tool', id }, parsed.tabRevision),
      );
      if (!path && !openPaths.length && !allowedTools.length) {
        if (this.peers.delete(parsed.identity.peerId)) {
          this.tabs.departed(parsed.identity.peerId);
          this.presenceRevision++;
          this.publish({ type: 'presence', snapshot: this.snapshot() });
        }
        return this.snapshot();
      }
      if (!this.peers.has(parsed.identity.peerId) && this.peers.size >= 128)
        throw new Error('rpc.limitExceeded');
      let color = this.colors.get(parsed.identity.userId);
      if (!color) {
        color = parsed.identity.color ?? COLLABORATION_COLORS[randomInt(COLLABORATION_COLORS.length)];
        this.colors.set(parsed.identity.userId, color);
        if (this.colors.size > 256) this.colors.delete(this.colors.keys().next().value!);
      }
      this.peers.set(parsed.identity.peerId, {
        ...parsed.identity,
        color,
        path,
        startLine: text ? parsed.startLine : 1,
        endLine: text ? parsed.endLine : 1,
        ...(text && parsed.cursor ? { cursor: parsed.cursor } : {}),
        editing: this.files.has(path) && parsed.editing,
        seenAt: new Date(this.now()).toISOString(),
        openPaths,
        ...(parsed.openTools || parsed.activeTool || (inactive && existing?.openTools)
          ? { openTools: allowedTools }
          : {}),
        ...(!inactive && parsed.activeTool && allowedTools.includes(parsed.activeTool)
          ? { activeTool: parsed.activeTool }
          : {}),
        ...(parsed.clientKind ? { clientKind: parsed.clientKind } : {}),
        ...(parsed.attention ? { attention: parsed.attention } : {}),
      });
      this.tabs.joined(this.peers.get(parsed.identity.peerId)!);
      this.presenceRevision++;
      const snapshot = this.snapshot();
      this.publish({ type: 'presence', snapshot });
      return snapshot;
    });
  }
  /** Native window state can revoke attention even when its renderer is suspended. */
  setAttention(peerIds: readonly string[]) {
    return this.exclusive(async () => {
      let changed = false;
      for (const id of peerIds) {
        const peer = this.peers.get(id);
        if (!peer || peer.attention === 'inactive') continue;
        this.peers.set(id, {
          ...peer,
          attention: 'inactive',
          path: '',
          startLine: 1,
          endLine: 1,
          cursor: undefined,
          editing: false,
          activeTool: undefined,
        });
        changed = true;
      }
      if (changed) {
        this.presenceRevision++;
        this.publish({ type: 'presence', snapshot: this.snapshot() });
      }
      return this.snapshot();
    });
  }
  edit(input: CollaborationEditRequest, trustedLocal = true, beforeApply?: () => void) {
    return this.exclusive(async (): Promise<CollaborationEditResult> => {
      this.requireWritable();
      const request = collaborationSchemas.edit.parse(input);
      if (request.changes.reduce((sum, change) => sum + change.text.length, 0) > MAX_TEXT)
        throw new Error('rpc.limitExceeded');
      await this.sync();
      beforeApply?.();
      this.requireProject(request.projectRoot, request.session);
      this.actor(request.peerId, request.actorToken, trustedLocal);
      const doc = this.document(request.path);
      if (this.tabs.locked(request.peerId, doc.value.path)) throw new Error('error.tabCloseChanged');
      const key = `${request.peerId}:${request.requestId}`;
      const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const cached = this.requests.get(key);
      if (cached) {
        if (cached.signature !== signature) throw new Error('rpc.invalidParams');
        return structuredClone(cached.result);
      }
      const conflict = (reason: CollaborationEditResult['reason']): CollaborationEditResult => ({
        status: 'conflict',
        document: structuredClone(doc.value),
        reason,
        ...(reason === 'diskChanged' ? { diskContent: doc.externalContent } : {}),
      });
      let result: CollaborationEditResult;
      if (doc.externalContent !== undefined) result = conflict('diskChanged');
      else if (request.baseRevision > doc.value.revision) throw new Error('rpc.invalidParams');
      else if (request.baseRevision < (doc.history[0]?.revision ?? doc.value.revision + 1) - 1)
        result = conflict('historyExpired');
      else {
        const history = doc.history.filter((entry) => entry.revision > request.baseRevision);
        const baseLength = history[0]?.beforeLength ?? doc.value.content.length;
        let changes: CollaborationChange[] | null = [...request.changes].sort(
          (a, b) => a.start - b.start || a.end - b.end,
        );
        let previous: CollaborationChange | undefined;
        for (const change of changes) {
          if (
            change.end < change.start ||
            change.end > baseLength ||
            (previous &&
              (change.start < previous.end ||
                (previous.start === previous.end &&
                  change.start === change.end &&
                  change.start === previous.start)))
          )
            throw new Error('rpc.invalidParams');
          previous = change;
        }
        for (const prior of history) {
          changes = transformCollaborationChanges(changes, prior.changes);
          if (!changes) break;
        }
        if (!changes) result = conflict('overlap');
        else {
          const content = applyCollaborationChanges(doc.value.content, changes);
          if (
            content.length > MAX_TEXT ||
            this.totalText() - doc.value.content.length + content.length > MAX_TOTAL_TEXT
          )
            throw new Error('rpc.limitExceeded');
          const previousRevision = doc.value.revision;
          this.changeDocument(doc, changes, request.peerId);
          result = { status: 'applied', document: structuredClone(doc.value), changes };
          this.publish({
            type: 'document',
            document: doc.value,
            previousRevision,
            changes,
            peerId: request.peerId,
            requestId: request.requestId,
          });
        }
      }
      this.remember(key, signature, result);
      return result;
    });
  }
  undo(input: CollaborationUndoRequest, trustedLocal = false) {
    return this.exclusive(async (): Promise<CollaborationEditResult> => {
      this.requireWritable();
      const request = collaborationSchemas.undo.parse(input);
      if (request.scope === 'global' && !trustedLocal)
        throw new Error('error.collaborationGlobalUndoForbidden');
      await this.sync();
      this.requireProject(request.projectRoot, request.session);
      this.actor(request.peerId, request.actorToken, trustedLocal);
      const doc = this.document(request.path);
      if (this.tabs.locked(request.peerId, doc.value.path)) throw new Error('error.tabCloseChanged');
      const key = `${request.peerId}:${request.requestId}`;
      const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const cached = this.requests.get(key);
      if (cached) {
        if (cached.signature !== signature) throw new Error('rpc.invalidParams');
        return structuredClone(cached.result);
      }
      const plan = planUndo(
        doc.undo,
        doc.history,
        request.peerId,
        request.direction,
        request.scope === 'global',
        doc.value.content,
      );
      let result: CollaborationEditResult;
      if (doc.externalContent !== undefined)
        result = {
          status: 'conflict',
          document: structuredClone(doc.value),
          reason: 'diskChanged',
          diskContent: doc.externalContent,
        };
      else if (typeof plan === 'string')
        result = { status: 'conflict', document: structuredClone(doc.value), reason: plan };
      else if (!plan) result = { status: 'applied', document: structuredClone(doc.value), changes: [] };
      else {
        const before = doc.value.content,
          previousRevision = doc.value.revision;
        const inverse = inverseChanges(before, plan.changes);
        const content = applyCollaborationChanges(before, plan.changes);
        if (content.length > MAX_TEXT || this.totalText() - before.length + content.length > MAX_TOTAL_TEXT)
          throw new Error('rpc.limitExceeded');
        this.changeDocument(doc, plan.changes);
        const expected = inverse.map((change) => doc.value.content.slice(change.start, change.end));
        if (request.direction === 'undo') {
          plan.group.active = false;
          plan.group.undoEvents.push(doc.value.revision);
          plan.group.undoEvents = plan.group.undoEvents.slice(-512);
          plan.group.redo = { revision: doc.value.revision, changes: inverse, expected };
        } else {
          plan.group.active = true;
          plan.group.revision = doc.value.revision;
          plan.group.changes = inverse;
          plan.group.expected = expected;
          plan.group.events.push(doc.value.revision);
          plan.group.events = plan.group.events.slice(-512);
          plan.group.redo = undefined;
          plan.group.at = 0;
        }
        result = { status: 'applied', document: structuredClone(doc.value), changes: plan.changes };
        this.publish({
          type: 'document',
          document: doc.value,
          previousRevision,
          changes: plan.changes,
          peerId: request.peerId,
          requestId: request.requestId,
        });
      }
      this.remember(key, signature, result);
      return result;
    });
  }
  leave(input: string | CollaborationLeaveRequest, trustedLocal = true) {
    return this.exclusive(async () => {
      const request = collaborationSchemas.leave.parse(typeof input === 'string' ? { peerId: input } : input);
      if (!trustedLocal && typeof input === 'string') throw new Error('error.collaborationActorRequired');
      if (request.projectRoot && request.projectRoot !== this.projectRoot) return;
      if (request.session && request.session !== this.session) return;
      const peerId = request.peerId;
      this.actor(peerId, request.actorToken, trustedLocal);
      const previous = this.presenceOrder.get(peerId);
      if (previous && (request.sequence === undefined ? !trustedLocal : request.sequence < previous.sequence))
        return;
      const sequence = request.sequence ?? (previous ? previous.sequence + 1 : undefined);
      if (sequence !== undefined) this.presenceOrder.set(peerId, { sequence, departed: true });
      const removed = this.peers.delete(peerId);
      const aborted = this.tabs.departed(peerId);
      if (removed || aborted) {
        this.presenceRevision++;
        this.publish({ type: 'presence', snapshot: this.snapshot() });
      }
    });
  }
  private async persist(doc: DocumentState, revision?: number) {
    if (revision !== undefined && revision !== doc.value.revision)
      throw new Error('error.collaborationSaveConflict');
    if (doc.externalContent !== undefined) throw new Error('error.collaborationDiskChanged');
    if (!this.options.saveFile) throw new Error('error.desktopOnly');
    if (doc.value.dirty) {
      const workspace = await (this.options.freshWorkspace?.() ?? this.options.workspace());
      if (workspace.projectRoot !== doc.value.projectRoot)
        throw new Error('error.collaborationProjectChanged');
      const file = workspace.files.find((item) => normalizeCollaborationPath(item.path) === doc.value.path);
      if (!file) throw new Error('rpc.fileNotFound');
      if (file.content !== doc.diskContent) throw new Error('error.collaborationDiskChanged');
      await this.options.saveFile(doc.value.path, doc.value.content);
    }
    doc.diskContent = doc.value.content;
    doc.value.dirty = false;
    this.files.set(doc.value.path, doc.diskContent);
    this.publish({
      type: 'document',
      document: doc.value,
      previousRevision: doc.value.revision,
      changes: [],
    });
    return structuredClone(doc.value);
  }
  save(input: CollaborationSaveRequest) {
    return this.exclusive(async () => {
      this.requireWritable();
      const request = collaborationSchemas.save.parse(input);
      await this.sync(true);
      this.requireProject(request.projectRoot, request.session);
      return this.persist(this.document(request.path), request.revision);
    });
  }
  /** Legacy/AI writes may save current shared text, but cannot replace another user's draft. */
  writeFile(projectRoot: string, path: string, content: string) {
    return this.exclusive(async () => {
      this.requireWritable();
      await this.sync(true);
      this.requireProject(projectRoot);
      const normalized = normalizeCollaborationPath(path);
      if (!this.files.has(normalized)) {
        if (this.viewableFiles.has(normalized)) throw new Error('error.fileType');
        // A shared draft whose backing file disappeared must never be recreated silently.
        if (this.documents.has(normalized)) throw new Error('error.collaborationDiskChanged');
        if (content.length > MAX_TEXT) throw new Error('rpc.limitExceeded');
        if (!this.options.saveFile) throw new Error('error.desktopOnly');
        // Preserve core.saveFile's create-file behavior and its filesystem/path checks.
        await this.options.saveFile(normalized, content);
        await this.sync(true);
        this.requireProject(projectRoot);
        return;
      }
      const doc = this.document(normalized);
      if (doc.value.dirty && content !== doc.value.content)
        throw new Error('error.collaborationSaveConflict');
      if (doc.externalContent !== undefined) throw new Error('error.collaborationDiskChanged');
      if (
        content.length > MAX_TEXT ||
        this.totalText() - doc.value.content.length + content.length > MAX_TOTAL_TEXT
      )
        throw new Error('rpc.limitExceeded');
      if (content !== doc.value.content) {
        const previousRevision = doc.value.revision;
        const changes = [{ start: 0, end: doc.value.content.length, text: content }];
        this.changeDocument(doc, changes, '$native');
        this.publish({ type: 'document', document: doc.value, previousRevision, changes });
      }
      await this.persist(doc);
    });
  }
  private async flushDocuments() {
    await this.sync(true);
    const dirty = [...this.documents.values()].filter((doc) => doc.value.dirty);
    for (const doc of dirty) {
      if (!this.files.has(doc.value.path)) throw new Error('rpc.fileNotFound');
      if (doc.externalContent !== undefined) throw new Error('error.collaborationDiskChanged');
    }
    for (const doc of dirty) await this.persist(doc);
  }
  flush() {
    return this.exclusive(() => {
      this.requireWritable();
      return this.flushDocuments();
    });
  }
  /** File moves/deletes and project transitions cannot race queued shared edits. */
  workspaceAction<T>(action: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.requireWritable();
      await this.flushDocuments();
      let result: T;
      try {
        result = await action();
      } catch (error) {
        // Resync after a partly completed filesystem operation, preserving its original error.
        await this.sync(true).catch(() => {});
        throw error;
      }
      await this.sync(true);
      return result;
    });
  }
  resolve(input: CollaborationResolveRequest) {
    return this.exclusive(async () => {
      this.requireWritable();
      const request = collaborationSchemas.resolve.parse(input);
      await this.sync(true);
      this.requireProject(request.projectRoot, request.session);
      const doc = this.document(request.path);
      if (doc.value.revision !== request.revision || this.files.get(doc.value.path) !== request.diskContent)
        throw new Error('error.collaborationSaveConflict');
      if (this.totalText() - doc.value.content.length + request.content.length > MAX_TOTAL_TEXT)
        throw new Error('rpc.limitExceeded');
      const previousRevision = doc.value.revision;
      const changes = [{ start: 0, end: doc.value.content.length, text: request.content }];
      doc.diskContent = request.diskContent;
      doc.externalContent = undefined;
      this.changeDocument(doc, changes);
      this.publish({ type: 'document', document: doc.value, previousRevision, changes });
      return structuredClone(doc.value);
    });
  }
  /** Close decisions and queued peer writes share the same serialized boundary. */
  prepareShutdown(decision: 'clean' | 'saved' | 'discard') {
    return this.exclusive(async () => {
      this.requireWritable();
      await this.sync(true);
      if (decision === 'clean' && [...this.documents.values()].some((doc) => doc.value.dirty))
        throw new Error('error.unsavedChanges');
      this.shutdownPrepared = true;
      try {
        if (decision === 'saved') await this.flushDocuments();
        return this.snapshot();
      } catch (error) {
        this.shutdownPrepared = false;
        throw error;
      }
    });
  }
  cancelShutdown() {
    return this.exclusive(async () => {
      this.shutdownPrepared = false;
    });
  }
  dispose() {
    this.shutdownPrepared = true;
    clearInterval(this.timer);
  }
}
