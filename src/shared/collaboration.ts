/** Offsets count UTF-16 code units, matching Monaco's model offsets. */
export interface CollaborationChange {
  start: number;
  end: number;
  text: string;
}
export const COLLABORATION_COLORS = [
  '#2563eb',
  '#9333ea',
  '#0d9488',
  '#d97706',
  '#e11d48',
  '#4f46e5',
  '#0891b2',
  '#65a30d',
] as const;
export interface CollaborationIdentity {
  userId: string;
  peerId: string;
  name: string;
  color?: string;
}
export type CollaborationToolTab = import('./workspace-surfaces').WorkspaceToolId;
export interface WorkspaceTabCloseRequest {
  projectRoot: string;
  session: string;
  peerId: string;
  actorToken?: string;
  requestId: string;
  target: import('./workspace-surfaces').WorkspaceSyncTarget;
}
export interface WorkspaceTabCloseVote {
  projectRoot: string;
  session: string;
  peerId: string;
  actorToken?: string;
  requestId: string;
  decision: 'ready' | 'cancel';
  documentRevision?: number;
}
export interface WorkspaceTabCloseTransaction {
  requestId: string;
  target: import('./workspace-surfaces').WorkspaceSyncTarget;
  status: 'preparing' | 'committed' | 'aborted';
  revision: number;
  participants: string[];
  ready: string[];
  expiresAt: string;
  documentRevision?: number;
  reason?: 'changed' | 'departed' | 'timeout';
}
export interface WorkspaceTabClosure {
  target: import('./workspace-surfaces').WorkspaceSyncTarget;
  revision: number;
}
export interface WorkspaceSurfaceUpdate {
  projectRoot: string;
  session: string;
  peerId: string;
  actorToken?: string;
  target: import('./workspace-surfaces').WorkspaceSyncTarget;
  open: boolean;
}
export interface WorkspaceSurfaceBootstrap {
  projectRoot: string;
  session: string;
  peerId: string;
  actorToken?: string;
  surfaces: { target: import('./workspace-surfaces').WorkspaceSyncTarget; open: boolean }[];
}
export interface CollaborationPresenceInput {
  tabRevision?: number;
  /** Per-page private credential; never included in presence snapshots. */
  actorToken?: string;
  projectRoot: string;
  session?: string;
  /** Monotonic per-window ordering across presence, release and reconnect. */
  sequence?: number;
  identity: CollaborationIdentity;
  path: string;
  startLine: number;
  endLine: number;
  cursor?: { line: number; column: number };
  editing: boolean;
  openPaths?: string[];
  openTools?: CollaborationToolTab[];
  activeTool?: CollaborationToolTab;
  clientKind?: 'desktop' | 'web';
  attention?: 'active' | 'inactive';
  /** Native window attention generation; browser peers do not send this field. */
  attentionEpoch?: number;
}
export interface CollaborationLeaveRequest {
  peerId: string;
  actorToken?: string;
  projectRoot?: string;
  session?: string;
  sequence?: number;
}
export interface CollaborationPeer extends CollaborationIdentity {
  attention?: 'active' | 'inactive';
  color: string;
  path: string;
  startLine: number;
  endLine: number;
  cursor?: { line: number; column: number };
  editing: boolean;
  seenAt: string;
  openPaths?: string[];
  openTools?: CollaborationToolTab[];
  activeTool?: CollaborationToolTab;
  clientKind?: 'desktop' | 'web';
}
export interface CollaborationDocument {
  projectRoot: string;
  session: string;
  path: string;
  revision: number;
  content: string;
  dirty: boolean;
}
export interface CollaborationSnapshot {
  tabRevision?: number;
  closedTabs?: WorkspaceTabClosure[];
  tabCloses?: WorkspaceTabCloseTransaction[];
  surfaces?: {
    target: import('./workspace-surfaces').WorkspaceSyncTarget;
    open: boolean;
    revision: number;
  }[];
  projectRoot: string;
  session: string;
  /** Orders presence snapshots even when HTTP responses arrive after newer SSE frames. */
  presenceRevision?: number;
  peers: CollaborationPeer[];
  documents: { path: string; revision: number; dirty: boolean }[];
}
export interface CollaborationEditRequest {
  actorToken?: string;
  projectRoot: string;
  session: string;
  path: string;
  peerId: string;
  requestId: string;
  baseRevision: number;
  changes: CollaborationChange[];
}
export interface CollaborationUndoRequest {
  projectRoot: string;
  session: string;
  path: string;
  peerId: string;
  actorToken?: string;
  requestId: string;
  direction: 'undo' | 'redo';
  scope?: 'own' | 'global';
}
export type CollaborationConflictReason = 'overlap' | 'historyExpired' | 'diskChanged';
export interface CollaborationEditResult {
  status: 'applied' | 'conflict';
  document: CollaborationDocument;
  /** Changes transformed onto the revision immediately preceding this result. */
  changes?: CollaborationChange[];
  reason?: CollaborationConflictReason;
  diskContent?: string;
}
export interface CollaborationSaveRequest {
  projectRoot: string;
  session: string;
  path: string;
  revision: number;
}
/** Explicit resolution against the exact disk text the user has reviewed. */
export interface CollaborationResolveRequest extends CollaborationSaveRequest {
  content: string;
  diskContent: string;
}
export type CollaborationEvent =
  | { type: 'presence'; snapshot: CollaborationSnapshot }
  | { type: 'workspace'; snapshot: CollaborationSnapshot }
  | {
      type: 'document';
      document: CollaborationDocument;
      previousRevision: number;
      changes: CollaborationChange[];
      peerId?: string;
      requestId?: string;
    }
  | {
      type: 'conflict';
      document: CollaborationDocument;
      reason: CollaborationConflictReason;
      diskContent?: string;
    };
export interface CollaborationApi {
  collaborationSurfaceBootstrap(request: WorkspaceSurfaceBootstrap): Promise<CollaborationSnapshot>;
  collaborationSurfaceUpdate(request: WorkspaceSurfaceUpdate): Promise<CollaborationSnapshot>;
  collaborationTabClose(request: WorkspaceTabCloseRequest): Promise<CollaborationSnapshot>;
  collaborationTabCloseVote(request: WorkspaceTabCloseVote): Promise<CollaborationSnapshot>;
  collaborationState(): Promise<CollaborationSnapshot>;
  collaborationOpen(projectRoot: string, path: string): Promise<CollaborationDocument>;
  collaborationPresence(input: CollaborationPresenceInput): Promise<CollaborationSnapshot>;
  collaborationEdit(request: CollaborationEditRequest): Promise<CollaborationEditResult>;
  collaborationUndo(request: CollaborationUndoRequest): Promise<CollaborationEditResult>;
  collaborationSave(request: CollaborationSaveRequest): Promise<CollaborationDocument>;
  collaborationResolve(request: CollaborationResolveRequest): Promise<CollaborationDocument>;
  collaborationLeave(request: string | CollaborationLeaveRequest): Promise<void>;
  onCollaboration(callback: (event: CollaborationEvent) => void): () => void;
}
