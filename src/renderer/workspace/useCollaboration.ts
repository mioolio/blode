import { useEffect, useRef, useState } from 'react';
import {
  COLLABORATION_COLORS,
  type CollaborationDocument,
  type CollaborationEvent,
  type CollaborationIdentity,
  type CollaborationEditRequest,
  type CollaborationPeer,
  type CollaborationSnapshot,
} from '../../shared/collaboration';
import { mergeText, textChanges } from '../editor/collaborationText';
import { registerCollaborationFlush } from './collaborationFlush';
import { registerFileCloseHandler } from './fileClose';
import { localTabPresence } from './localPresence';
import { observePageAttention, type AttentionSnapshot } from './attention';
import { CollaborationResume, retainLocalDocuments } from './collaborationResume';
import type { Studio } from './useStudio';
import { workspaceFileView } from '../../shared/file-views';
import { workspaceSurfaces } from '../../shared/workspace-surfaces';
import { SharedSurfaceOutbox, SharedWorkspaceClient, registerSharedWorkspaceHandler } from './sharedTabs';

export interface EditorPresence {
  path: string;
  startLine: number;
  endLine: number;
  cursor?: { line: number; column: number };
}
export interface CollaborationConflict {
  path: string;
  local: string;
  shared: string;
  reason: string;
  disk?: string;
}
interface OpenDocument {
  baseline: string;
  local: string;
  document?: CollaborationDocument;
  opening?: Promise<void>;
  sending?: Promise<void>;
  request?: { id: string; submitted: string; acknowledged: boolean; payload: CollaborationEditRequest };
  conflict?: CollaborationConflict;
  deferred?: CollaborationDocument;
}

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `peer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

function identity(): CollaborationIdentity {
  const peerId = newId();
  try {
    const saved = JSON.parse(localStorage.getItem('blode.collaboration.user') ?? 'null');
    if (saved && typeof saved.userId === 'string' && typeof saved.name === 'string')
      return {
        userId: saved.userId,
        name:
          saved.name === 'User peer' && saved.userId.startsWith('peer-')
            ? `User ${saved.userId.slice(-4)}`
            : saved.name.slice(0, 40),
        color: COLLABORATION_COLORS.includes(saved.color) ? saved.color : COLLABORATION_COLORS[0],
        peerId,
      };
  } catch {
    /* A new identity is enough when browser storage is blocked. */
  }
  const userId = newId();
  const result = {
    userId,
    name: `User ${userId.slice(-4)}`,
    color: COLLABORATION_COLORS[Math.floor(Math.random() * COLLABORATION_COLORS.length)],
  };
  try {
    localStorage.setItem('blode.collaboration.user', JSON.stringify(result));
  } catch {}
  return { ...result, peerId };
}

/** Versioned shared drafts; a failed/overlapping merge always leaves the user's text intact. */
export function useCollaboration(studio: Studio) {
  const [self] = useState(identity);
  const [actorToken] = useState(() =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ),
  );
  const [peers, setPeers] = useState<CollaborationPeer[]>([]);
  const [conflicts, setConflicts] = useState<CollaborationConflict[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const latest = useRef(studio);
  latest.current = studio;
  const records = useRef(new Map<string, OpenDocument>());
  const session = useRef('');
  const generation = useRef(0);
  const presenceSequence = useRef(0);
  const receivedPresenceRevision = useRef(-1);
  const paused = useRef(false);
  const pageDeparted = useRef(false);
  const recovering = useRef(false);
  const attention = useRef<ReturnType<typeof observePageAttention> | undefined>(undefined);
  const resumeCoordinator = useRef(new CollaborationResume());
  const retiredSessions = useRef(new Set<string>());
  const transportAvailable = useRef(true);
  const closingPaths = useRef(new Set<string>());
  const closingTools = useRef(new Set<string>());
  const preparedContexts = useRef(new Map<string, { root: string; session: string }>());
  const preparedCloses = useRef(new Map<string, { path: string; revision: number; ready?: boolean }>());
  const presenceActive = useRef(false);
  const previousOpenFiles = useRef<string[]>(studio.openFiles);
  const previousOpenTools = useRef<readonly string[]>(studio.openTools);
  const currentView = useRef<(EditorPresence & { ownerPath?: string }) | undefined>(undefined);
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waitingViewport = useRef(false);
  const editedAt = useRef(0);
  const surfaceOutbox = useRef(new SharedSurfaceOutbox());
  const surfaceSending = useRef<Promise<void> | undefined>(undefined);
  const bootstrappedSurfaces = useRef('');
  const root = studio.state?.projectRoot ?? '';
  const connected = !!root && typeof window.blode.collaborationState === 'function';
  const enabled = connected && studio.syncDrafts;
  const sharedWorkspace = useRef<SharedWorkspaceClient | null>(null);
  if (!sharedWorkspace.current)
    sharedWorkspace.current = new SharedWorkspaceClient({
      context: () =>
        latest.current.state?.projectRoot && session.current
          ? {
              projectRoot: latest.current.state.projectRoot,
              session: session.current,
              peerId: self.peerId,
              actorToken,
            }
          : undefined,
      request: (context, target, requestId) =>
        window.blode.collaborationTabClose({ ...context, target, requestId }),
      owns: (target) =>
        target.kind === 'file'
          ? latest.current.openFiles.includes(target.id) || Object.hasOwn(latest.current.drafts, target.id)
          : target.kind === 'tool'
            ? latest.current.openTools.some((id) => id === target.id)
            : true,
      vote: async (context, requestId, decision, target) => {
        let documentRevision = preparedCloses.current.get(requestId)?.revision;
        if (
          decision === 'ready' &&
          target.kind === 'file' &&
          latest.current.preparedSharedTabDecision(target.id, requestId) === 'save'
        ) {
          const current = await window.blode.collaborationOpen(context.projectRoot, target.id);
          if (current.content !== latest.current.preparedSharedTabContent(target.id, requestId))
            decision = 'cancel';
          documentRevision = current.revision;
        }
        if (decision === 'ready') {
          const prepared = preparedCloses.current.get(requestId);
          if (prepared) prepared.ready = true;
        }
        return window.blode.collaborationTabCloseVote({ ...context, requestId, decision, documentRevision });
      },
      prepare: async (target, requestId) => {
        const expected = { root: latest.current.state?.projectRoot ?? '', session: session.current };
        if (!expected.root || !expected.session) return false;
        preparedContexts.current.set(requestId, expected);
        if (target.kind === 'file' && workspaceFileView(latest.current.state, target.id) === 'text') {
          const root = latest.current.state!.projectRoot;
          const current = await window.blode.collaborationOpen(root, target.id);
          if (latest.current.state?.projectRoot !== expected.root || session.current !== expected.session)
            return false;
          preparedCloses.current.set(requestId, { path: target.id, revision: current.revision });
          if (latest.current.syncDrafts) {
            const record = records.current.get(target.id);
            if (record) actions.current.adopt(current);
            else {
              const local = latest.current.drafts[target.id];
              const baseline =
                latest.current.state!.files.find((file) => file.path === target.id)?.content ??
                current.content;
              records.current.set(target.id, {
                baseline,
                local: local ?? current.content,
                ...(local === undefined ? { document: current } : {}),
              });
              if (local !== undefined) actions.current.adopt(current);
            }
          }
          return latest.current.prepareSharedTabClose(target, requestId, {
            content: current.content,
            dirty: current.dirty,
          });
        }
        return latest.current.prepareSharedTabClose(target, requestId);
      },
      commit: async (target, requestId) => {
        const expected = preparedContexts.current.get(requestId);
        if (
          !expected ||
          latest.current.state?.projectRoot !== expected.root ||
          session.current !== expected.session
        )
          return false;
        const result = await latest.current.commitSharedTabClose(target, requestId);
        if (result !== false) {
          if (target.kind === 'file') {
            closingPaths.current.add(target.id);
            records.current.delete(target.id);
          }
          if (target.kind === 'tool') closingTools.current.add(target.id);
        }
        preparedCloses.current.delete(requestId);
        preparedContexts.current.delete(requestId);
        return result;
      },
      abort: (target, requestId) => {
        preparedCloses.current.delete(requestId);
        preparedContexts.current.delete(requestId);
        latest.current.abortSharedTabClose(target, requestId);
        if (target.kind === 'file' && records.current.has(target.id)) {
          const projectRoot = latest.current.state?.projectRoot;
          if (projectRoot)
            void window.blode
              .collaborationOpen(projectRoot, target.id)
              .then((document) => actions.current.adopt(document))
              .catch(() => {});
        }
      },
      surface: (target, open) => latest.current.applySharedSurface(target, open),
      failure: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        setConnectionError(message);
        if (message === 'error.tabCloseChanged')
          latest.current.notify(latest.current.t(message), false, true);
      },
      changed: () => {
        clearTimeout(presenceTimer.current);
        presenceTimer.current = setTimeout(() => actions.current.sendPresence(), 0);
      },
    });
  const isTextDocument = (path: string) => workspaceFileView(latest.current.state, path) === 'text';
  const updateConflicts = () =>
    setConflicts(
      [...records.current.values()].flatMap((record) => (record.conflict ? [record.conflict] : [])),
    );
  const writeDraft = (path: string, content: string) => {
    const owner = latest.current;
    if (!isTextDocument(path)) return;
    owner.setSharedDrafts((drafts) => {
      if (content === owner.state?.files.find((file) => file.path === path)?.content) {
        if (!Object.hasOwn(drafts, path)) return drafts;
        const next = { ...drafts };
        delete next[path];
        return next;
      }
      if (drafts[path] === content) return drafts;
      return { ...drafts, [path]: content };
    });
    owner.setStale(true);
  };
  const conflict = (
    path: string,
    record: OpenDocument,
    document: CollaborationDocument,
    reason = 'overlap',
    disk?: string,
  ) => {
    record.document = document;
    record.conflict = { path, local: record.local, shared: disk ?? document.content, reason, disk };
    updateConflicts();
  };
  const adopt = (document: CollaborationDocument, requestId?: string) => {
    if (document.projectRoot !== root || (session.current && document.session !== session.current)) return;
    const record = records.current.get(document.path);
    if (!record || closingPaths.current.has(document.path)) return;
    if (
      [...preparedCloses.current.values()].some(
        (prepared) => prepared.path === document.path && prepared.ready,
      )
    )
      return;
    if (
      !record.document &&
      record.local !== record.baseline &&
      document.content !== record.baseline &&
      record.local !== document.content
    ) {
      // A restored offline draft has no shared base revision; do not guess whether its edits were already sent.
      conflict(document.path, record, document, 'historyExpired');
      return;
    }
    const request = record.request;
    if (request && requestId === request.id && !request.acknowledged) {
      request.acknowledged = true;
      const merged = mergeText(request.submitted, record.local, document.content);
      if (merged === null) {
        conflict(document.path, record, document);
        return;
      }
      record.document = document;
      record.local = merged;
      writeDraft(document.path, merged);
      const deferred = record.deferred;
      record.deferred = undefined;
      if (deferred && deferred.revision > document.revision) adopt(deferred);
      return;
    }
    if (record.document && document.revision <= record.document.revision) {
      if (document.revision === record.document.revision) record.document = document;
      return;
    }
    if (request && !request.acknowledged) {
      if (!record.deferred || document.revision > record.deferred.revision) record.deferred = document;
      return; // The server transforms the pending edit before acknowledging it.
    }
    if (record.conflict) {
      record.document = document;
      record.conflict = { ...record.conflict, shared: record.conflict.disk ?? document.content };
      updateConflicts();
      return;
    }
    const merged = mergeText(record.document?.content ?? record.baseline, record.local, document.content);
    if (merged === null) {
      conflict(document.path, record, document);
      return;
    }
    record.document = document;
    record.local = merged;
    writeDraft(document.path, merged);
  };
  const ensureOpen = async (path: string): Promise<OpenDocument> => {
    if (closingPaths.current.has(path) || !isTextDocument(path)) throw new Error('rpc.fileNotFound');
    let record = records.current.get(path);
    if (!record) {
      const file = latest.current.state?.files.find((file) => file.path === path);
      if (!file) throw new Error('rpc.fileNotFound');
      record = { baseline: file.content, local: latest.current.drafts[path] ?? file.content };
      records.current.set(path, record);
    }
    if (!record.document && !record.opening) {
      const owner = record,
        revision = generation.current;
      owner.opening = window.blode
        .collaborationOpen(root, path)
        .then((document) => {
          if (revision !== generation.current || records.current.get(path) !== owner) return;
          if (session.current && document.session !== session.current) return;
          session.current = document.session;
          adopt(document);
        })
        .finally(() => {
          owner.opening = undefined;
        });
    }
    await record.opening;
    return record;
  };
  const flushOne = async (path: string): Promise<void> => {
    const record = await ensureOpen(path);
    if (record.sending) return record.sending;
    const revision = generation.current;
    record.sending = (async () => {
      while (
        enabled &&
        revision === generation.current &&
        record.document &&
        (record.local !== record.document.content || (record.request && !record.request.acknowledged))
      ) {
        if (record.conflict) throw new Error('collaboration.conflictPending');
        const existing = record.request && !record.request.acknowledged ? record.request : undefined;
        const requestId = existing?.id ?? newId();
        const submitted = existing?.submitted ?? record.local;
        const document = record.document;
        const payload = existing?.payload ?? {
          projectRoot: root,
          session: document.session,
          path,
          peerId: self.peerId,
          actorToken,
          requestId,
          baseRevision: document.revision,
          changes: textChanges(document.content, submitted),
        };
        record.request = existing ?? { id: requestId, submitted, acknowledged: false, payload };
        const result = await window.blode.collaborationEdit(payload);
        if (revision !== generation.current || records.current.get(path) !== record) return;
        if (result.status === 'conflict') {
          conflict(path, record, result.document, result.reason, result.diskContent);
          throw new Error('collaboration.conflictPending');
        }
        adopt(result.document, requestId);
        record.request = undefined;
      }
      if (record.conflict) throw new Error('collaboration.conflictPending');
    })().finally(() => {
      record.sending = undefined;
      // An unknown network result must retry the same id, otherwise an applied edit could be inserted twice.
      if (record.conflict || record.request?.acknowledged) record.request = undefined;
    });
    return record.sending;
  };
  const receiveSnapshot = (value: CollaborationSnapshot) => {
    if (value.projectRoot !== root || retiredSessions.current.has(value.session)) return false;
    if (session.current && session.current !== value.session) {
      retiredSessions.current.add(session.current);
      if (retiredSessions.current.size > 32)
        retiredSessions.current.delete(retiredSessions.current.values().next().value!);
      generation.current++;
      records.current = retainLocalDocuments(records.current);
      receivedPresenceRevision.current = -1;
      setConflicts([]);
    }
    const stalePeers =
      value.session === session.current &&
      value.presenceRevision !== undefined &&
      value.presenceRevision < receivedPresenceRevision.current;
    if (value.presenceRevision !== undefined)
      receivedPresenceRevision.current = Math.max(receivedPresenceRevision.current, value.presenceRevision);
    session.current = value.session;
    sharedWorkspace.current!.accept(value);
    if (!stalePeers)
      setPeers(
        transportAvailable.current
          ? value.peers
          : value.peers.map((peer) => ({
              ...peer,
              attention: 'inactive',
              path: '',
              cursor: undefined,
              editing: false,
              activeTool: undefined,
            })),
      );
    actions.current.publishSurfaces();
    return true;
  };
  const leavePresence = () => {
    currentView.current = undefined;
    clearTimeout(presenceTimer.current);
    presenceActive.current = false;
    if (root)
      void window.blode
        .collaborationLeave({
          peerId: self.peerId,
          actorToken,
          projectRoot: root,
          ...(session.current ? { session: session.current } : {}),
          sequence: ++presenceSequence.current,
        })
        .catch(() => {});
  };
  const sendPresence = () => {
    const owner = latest.current;
    if (!connected || pageDeparted.current || recovering.current || owner.state?.projectRoot !== root) return;
    let selected = localTabPresence(
      { ...owner, files: owner.state?.files ?? [], inventory: owner.state?.inventory },
      currentView.current,
      closingPaths.current,
      closingTools.current,
    );
    if (!selected) {
      if (presenceActive.current) leavePresence();
      return;
    }
    if (owner.showHome || paused.current || attention.current?.snapshot().active === false) {
      sendInactive(true);
      return;
    }
    if (waitingViewport.current && selected.path && isTextDocument(selected.path))
      selected = { ...selected, path: '', startLine: 1, endLine: 1, cursor: undefined };
    if (selected.path) currentView.current = { ...selected, ownerPath: owner.activePath };
    else currentView.current = undefined;
    presenceActive.current = true;
    const revision = generation.current,
      sequence = ++presenceSequence.current;
    void (
      enabled && selected.path && isTextDocument(selected.path)
        ? actions.current.ensureOpen(selected.path)
        : Promise.resolve()
    )
      .then(() => {
        if (revision !== generation.current || sequence !== presenceSequence.current || paused.current)
          return;
        return window.blode.collaborationPresence({
          projectRoot: root,
          session: session.current || undefined,
          sequence,
          tabRevision: sharedWorkspace.current!.tabRevision,
          identity: self,
          actorToken,
          ...selected,
          attention: 'active',
          attentionEpoch: attention.current?.snapshot().nativeEpoch,
          editing: !!selected.path && isTextDocument(selected.path) && Date.now() - editedAt.current < 1800,
        });
      })
      .then((snapshot) => {
        if (
          !snapshot ||
          revision !== generation.current ||
          sequence !== presenceSequence.current ||
          paused.current
        )
          return;
        actions.current.receiveSnapshot(snapshot);
        setConnectionError('');
      })
      .catch((error) => {
        if (revision === generation.current && sequence === presenceSequence.current && !paused.current)
          setConnectionError(error instanceof Error ? error.message : String(error));
      });
  };
  const sendInactive = (includeTabs = false) => {
    clearTimeout(presenceTimer.current);
    const owner = latest.current;
    if (!connected || pageDeparted.current || owner.state?.projectRoot !== root) return;
    const selected = includeTabs
      ? localTabPresence(
          { ...owner, files: owner.state?.files ?? [], inventory: owner.state?.inventory },
          currentView.current,
          closingPaths.current,
          closingTools.current,
        )
      : undefined;
    if (includeTabs && !selected) {
      actions.current.leavePresence();
      return;
    }
    const sequence = ++presenceSequence.current;
    const revision = generation.current;
    presenceActive.current = true;
    void window.blode
      .collaborationPresence({
        projectRoot: root,
        session: session.current || undefined,
        sequence,
        tabRevision: sharedWorkspace.current!.tabRevision,
        identity: self,
        actorToken,
        path: '',
        startLine: 1,
        endLine: 1,
        editing: false,
        attention: 'inactive',
        attentionEpoch: attention.current?.snapshot().nativeEpoch,
        clientKind: owner.isWeb ? 'web' : 'desktop',
        ...(selected ? { openPaths: selected.openPaths, openTools: selected.openTools } : {}),
      })
      .then((snapshot) => {
        if (revision === generation.current && sequence === presenceSequence.current)
          actions.current.receiveSnapshot(snapshot);
      })
      .catch(() => {});
  };
  const reportPresence = (view: EditorPresence) => {
    const owner = latest.current;
    if (
      !owner.isWeb ||
      paused.current ||
      closingPaths.current.has(view.path) ||
      owner.showHome ||
      owner.view !== 'code' ||
      !owner.openFiles.includes(view.path) ||
      !isTextDocument(view.path)
    )
      return;
    if (enabled)
      void actions.current.ensureOpen(view.path).catch((error) => setConnectionError(String(error)));
    currentView.current = { ...view, ownerPath: owner.activePath };
    waitingViewport.current = false;
    clearTimeout(presenceTimer.current);
    presenceTimer.current = setTimeout(sendPresence, 180);
  };
  const reportEdit = (path: string, content: string) => {
    if (!enabled || !isTextDocument(path)) return;
    editedAt.current = Date.now();
    clearTimeout(editingTimer.current);
    editingTimer.current = setTimeout(() => actions.current.sendPresence(), 1900);
    const record = records.current.get(path);
    if (record) {
      record.local = content;
      if (record.conflict) {
        record.conflict = { ...record.conflict, local: content };
        updateConflicts();
      }
    } else {
      const baseline = latest.current.state?.files.find((file) => file.path === path)?.content ?? '';
      records.current.set(path, { baseline, local: content });
    }
    reportPresence({ ...(currentView.current ?? { startLine: 1, endLine: 1 }), path });
    void flushOne(path)
      .then(() => setConnectionError(''))
      .catch((error) => {
        if (!records.current.get(path)?.conflict)
          setConnectionError(error instanceof Error ? error.message : String(error));
      });
  };
  const publishSurfaces = () => {
    if (!connected || !transportAvailable.current || surfaceSending.current) return;
    const revision = generation.current;
    const operation = (async () => {
      if (!session.current) actions.current.receiveSnapshot(await window.blode.collaborationState());
      if (revision !== generation.current || latest.current.state?.projectRoot !== root || !session.current)
        return;
      const key = `${root}\0${session.current}`;
      if (bootstrappedSurfaces.current !== key) {
        const owner = latest.current;
        const panels: Record<string, boolean> = {
          console: owner.consolePanelVisible,
          device: owner.devicePanelVisible,
          runtime: owner.runtimeExpanded,
        };
        const snapshot = await window.blode.collaborationSurfaceBootstrap({
          projectRoot: root,
          session: session.current,
          peerId: self.peerId,
          actorToken,
          surfaces: [
            { target: { kind: 'console', id: owner.tab }, open: true },
            ...workspaceSurfaces
              .filter((surface) => surface.kind === 'panel')
              .map((target) => ({ target, open: panels[target.id] ?? false })),
          ],
        });
        if (revision !== generation.current) return;
        bootstrappedSurfaces.current = key;
        actions.current.receiveSnapshot(snapshot);
      }
      await surfaceOutbox.current.flush(async (target, open) => {
        if (revision !== generation.current || latest.current.state?.projectRoot !== root)
          throw new Error('error.collaborationProjectChanged');
        if (!session.current) actions.current.receiveSnapshot(await window.blode.collaborationState());
        if (revision !== generation.current || latest.current.state?.projectRoot !== root || !session.current)
          throw new Error('error.collaborationProjectChanged');
        const value = await window.blode.collaborationSurfaceUpdate({
          projectRoot: root,
          session: session.current,
          peerId: self.peerId,
          actorToken,
          target,
          open,
        });
        if (revision === generation.current) actions.current.receiveSnapshot(value);
      });
    })();
    surfaceSending.current = operation;
    void operation.then(
      () => {
        if (surfaceSending.current !== operation) return;
        surfaceSending.current = undefined;
        if (surfaceOutbox.current.hasPending) actions.current.publishSurfaces();
      },
      (error) => {
        if (surfaceSending.current === operation) surfaceSending.current = undefined;
        if (revision === generation.current) setConnectionError(String(error));
      },
    );
  };
  const actions = useRef({
    adopt,
    ensureOpen,
    flushOne,
    sendPresence,
    sendInactive,
    receiveSnapshot,
    leavePresence,
    publishSurfaces,
  });
  actions.current = {
    adopt,
    ensureOpen,
    flushOne,
    sendPresence,
    sendInactive,
    receiveSnapshot,
    leavePresence,
    publishSurfaces,
  };

  useEffect(() => {
    generation.current++;
    records.current.clear();
    closingPaths.current.clear();
    closingTools.current.clear();
    presenceActive.current = false;
    receivedPresenceRevision.current = -1;
    retiredSessions.current.clear();
    transportAvailable.current = true;
    pageDeparted.current = false;
    editedAt.current = 0;
    paused.current = true;
    recovering.current = false;
    session.current = '';
    setPeers([]);
    setConflicts([]);
    setConnectionError('');
    if (!connected) return;
    let disposed = false;
    const observer = observePageAttention(
      window,
      document,
      navigator,
      window.blode.onWindowAttention?.bind(window.blode),
    );
    const transport = observer.registerSource('transport', true);
    attention.current = observer;
    paused.current = !observer.snapshot().active;
    const snapshot = (value: CollaborationSnapshot) => {
      if (disposed || value.projectRoot !== root) return;
      actions.current.receiveSnapshot(value);
    };
    const unsubscribe = window.blode.onCollaboration((event: CollaborationEvent) => {
      if (disposed) return;
      if (event.type === 'workspace' || event.type === 'presence') snapshot(event.snapshot);
      if (enabled && event.type === 'document') actions.current.adopt(event.document, event.requestId);
      if (
        event.type === 'conflict' &&
        event.reason === 'diskChanged' &&
        event.document.projectRoot === root
      ) {
        const record = records.current.get(event.document.path);
        if (record && !closingPaths.current.has(event.document.path))
          conflict(event.document.path, record, event.document, event.reason, event.diskContent);
      }
    });
    const heartbeat = setInterval(() => {
      actions.current.sendPresence();
      if (!enabled) return;
      for (const [path, record] of records.current)
        if (
          isTextDocument(path) &&
          !record.sending &&
          !record.conflict &&
          (record.request || (record.document && record.local !== record.document.content))
        )
          void actions.current
            .flushOne(path)
            .then(() => setConnectionError(''))
            .catch((error) => setConnectionError(String(error)));
    }, 10_000);
    const unregister = registerCollaborationFlush(async () => {
      if (!enabled) return {};
      const paths = [...new Set([...records.current.keys(), ...Object.keys(latest.current.drafts)])].filter(
        isTextDocument,
      );
      for (const path of paths) await actions.current.flushOne(path);
      return Object.fromEntries(
        [...records.current.entries()]
          .filter(([path]) => isTextDocument(path))
          .map(([path, record]) => [path, record.local]),
      );
    });
    const leave = () => {
      pageDeparted.current = true;
      resumeCoordinator.current.invalidate();
      paused.current = true;
      recovering.current = false;
      leavePresence();
    };
    const resume = () => {
      if (disposed || !observer.snapshot().active) return;
      pageDeparted.current = false;
      paused.current = false;
      recovering.current = true;
      const expectedSession = session.current;
      const owns = (path: string) =>
        !closingPaths.current.has(path) &&
        isTextDocument(path) &&
        (latest.current.openFiles.includes(path) ||
          latest.current.activePath === path ||
          Object.hasOwn(latest.current.drafts, path));
      void resumeCoordinator.current.run({
        active: () => !disposed && !paused.current && observer.snapshot().active,
        snapshot: () => window.blode.collaborationState(),
        adoptSnapshot: (value) => {
          if (session.current !== expectedSession && value.session !== session.current) return false;
          return actions.current.receiveSnapshot(value);
        },
        documents: (value) => {
          if (!enabled) return [];
          const versions = new Map(value.documents.map((item) => [item.path, item.revision]));
          return [
            ...new Set([
              latest.current.activePath,
              ...Object.keys(latest.current.drafts),
              ...records.current.keys(),
            ]),
          ].filter((path) => {
            const record = records.current.get(path);
            return (
              owns(path) &&
              (!record?.document ||
                record.document.session !== value.session ||
                record.document.revision !== versions.get(path) ||
                !!record.request ||
                !!record.conflict)
            );
          });
        },
        owns,
        open: async (path) => {
          if (!records.current.get(path)?.document) {
            const record = await actions.current.ensureOpen(path);
            if (!record.document) throw new Error('rpc.fileNotFound');
            return record.document;
          }
          return window.blode.collaborationOpen(root, path);
        },
        adoptDocument: (value) => actions.current.adopt(value),
        publish: () => {
          recovering.current = false;
          waitingViewport.current =
            latest.current.isWeb &&
            latest.current.view === 'code' &&
            isTextDocument(latest.current.activePath);
          setConnectionError('');
          actions.current.sendPresence();
          window.dispatchEvent(new Event('blode:attention-restored'));
          if (!enabled) return;
          for (const [path, record] of records.current)
            if (
              owns(path) &&
              !record.sending &&
              !record.conflict &&
              (record.request || (record.document && record.local !== record.document.content))
            )
              void actions.current.flushOne(path).catch((error) => setConnectionError(String(error)));
        },
        failed: (error) => {
          recovering.current = false;
          setConnectionError(String(error));
        },
      });
    };
    let previousAttention: AttentionSnapshot = observer.snapshot();
    const unsubscribeAttention = observer.subscribe((value) => {
      const previous = previousAttention;
      previousAttention = value;
      if (!value.active) {
        if (previous.active) {
          resumeCoordinator.current.invalidate();
          paused.current = true;
          recovering.current = false;
          actions.current.sendInactive();
        }
      } else if (!previous.active || value.nativeEpoch !== previous.nativeEpoch) resume();
    });
    if (observer.snapshot().active) resume();
    else
      void window.blode
        .collaborationState()
        .then((value) => {
          if (!disposed && (!session.current || value.session === session.current)) snapshot(value);
        })
        .catch((error) => {
          if (!disposed) setConnectionError(String(error));
        });
    const disconnected = () => {
      transportAvailable.current = false;
      transport.update(false);
      setPeers((values) =>
        values.map((peer) => ({
          ...peer,
          attention: 'inactive',
          path: '',
          cursor: undefined,
          editing: false,
          activeTool: undefined,
        })),
      );
    };
    const reconnected = () => {
      const active = observer.snapshot().active;
      transportAvailable.current = true;
      transport.update(true);
      if (active) resume();
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('blode:collaboration-reconnect', reconnected);
    window.addEventListener('blode:collaboration-disconnect', disconnected);
    return () => {
      disposed = true;
      generation.current++;
      unsubscribe();
      unregister();
      leave();
      unsubscribeAttention();
      observer.close();
      attention.current = undefined;
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('blode:collaboration-reconnect', reconnected);
      window.removeEventListener('blode:collaboration-disconnect', disconnected);
      clearInterval(heartbeat);
      clearTimeout(presenceTimer.current);
      clearTimeout(editingTimer.current);
    };
  }, [root, connected, enabled, self.peerId, studio.isWeb]);
  useEffect(() => {
    if (!enabled) return;
    const paths = [...new Set([studio.activePath, ...Object.keys(studio.drafts)])].filter(isTextDocument);
    for (const path of paths)
      void actions.current.ensureOpen(path).catch((error) => setConnectionError(String(error)));
  }, [root, enabled, studio.activePath, studio.state?.files]);
  useEffect(() => {
    if (!connected) return;
    // Previews replaced by later navigation are no longer held by this window.
    for (const path of studio.openFiles)
      if (!previousOpenFiles.current.includes(path)) closingPaths.current.delete(path);
    previousOpenFiles.current = studio.openFiles;
    for (const tool of studio.openTools)
      if (!previousOpenTools.current.includes(tool)) closingTools.current.delete(tool);
    previousOpenTools.current = studio.openTools;
    for (const [path, record] of records.current)
      if (
        path !== studio.activePath &&
        path !== currentView.current?.path &&
        !Object.hasOwn(studio.drafts, path) &&
        !record.sending &&
        !record.request &&
        !record.conflict &&
        (!record.document || record.local === record.document.content)
      )
        records.current.delete(path);
    actions.current.sendPresence();
  }, [
    root,
    connected,
    studio.isWeb,
    studio.openFiles,
    studio.openTools,
    studio.activePath,
    studio.showHome,
    studio.view,
  ]);
  useEffect(() => {
    const client = sharedWorkspace.current!;
    client.reset();
    surfaceOutbox.current.reset();
    bootstrappedSurfaces.current = '';
    surfaceSending.current = undefined;
    if (!connected) return;
    const unregister = registerSharedWorkspaceHandler({
      close: async (target) => {
        try {
          if (!session.current) actions.current.receiveSnapshot(await window.blode.collaborationState());
          if (latest.current.state?.projectRoot !== root) return false;
          return await client.close(target);
        } catch (error) {
          setConnectionError(String(error));
          return false;
        }
      },
      publish: (target, open) => {
        surfaceOutbox.current.publish(target, open);
        actions.current.publishSurfaces();
      },
    });
    return () => {
      unregister();
      client.reset();
      surfaceOutbox.current.reset();
      bootstrappedSurfaces.current = '';
      surfaceSending.current = undefined;
    };
  }, [root, connected]);
  useEffect(() => {
    if (!connected) return;
    const unregister = enabled
      ? registerFileCloseHandler(async (requestRoot, path, decision) => {
          if (requestRoot !== root) return false;
          const record = records.current.get(path);
          if (!isTextDocument(path)) {
            if (decision === 'save') throw new Error('project.notEditable');
            return true;
          }
          if (decision === 'save') {
            await actions.current.flushOne(path);
            const current = records.current.get(path),
              document = current?.document;
            if (!document) throw new Error('rpc.fileNotFound');
            const saved = await window.blode.collaborationSave({
              projectRoot: root,
              session: document.session,
              path,
              revision: document.revision,
            });
            actions.current.adopt(saved);
            return true;
          }
          if (record?.sending) await record.sending.catch(() => {});
          return true;
        })
      : () => {};
    const closed = (event: Event) => {
      const detail = (event as CustomEvent<{ root: string; path: string }>).detail;
      if (detail?.root !== root) return;
      closingPaths.current.add(detail.path);
      records.current.delete(detail.path);
      updateConflicts();
      if (currentView.current?.path === detail.path) currentView.current = undefined;
      actions.current.sendPresence();
    };
    const opened = (event: Event) => {
      const detail = (event as CustomEvent<{ root: string; path: string }>).detail;
      if (detail?.root !== root) return;
      closingPaths.current.delete(detail.path);
      if (!enabled || !isTextDocument(detail.path)) {
        actions.current.sendPresence();
        return;
      }
      void actions.current
        .ensureOpen(detail.path)
        .then(() => actions.current.sendPresence())
        .catch((error) => setConnectionError(String(error)));
    };
    window.addEventListener('blode:file-opened', opened);
    window.addEventListener('blode:file-closed', closed);
    const toolClosed = (event: Event) => {
      const detail = (event as CustomEvent<{ root: string; id: string }>).detail;
      if (detail?.root !== root) return;
      closingTools.current.add(detail.id);
      actions.current.sendPresence();
    };
    window.addEventListener('blode:tool-closed', toolClosed);
    return () => {
      unregister();
      window.removeEventListener('blode:file-closed', closed);
      window.removeEventListener('blode:file-opened', opened);
      window.removeEventListener('blode:tool-closed', toolClosed);
    };
  }, [root, connected, enabled]);

  return {
    peers: peers.filter((peer) => peer.peerId !== self.peerId && peer.attention !== 'inactive'),
    allPeers: peers.filter((peer) => peer.attention !== 'inactive'),
    self,
    conflicts,
    connectionError,
    enabled,
    reportPresence,
    reportEdit,
    remotePaths: [
      ...new Set(
        peers
          .filter((peer) => peer.peerId !== self.peerId)
          .flatMap((peer) => peer.openPaths ?? (peer.path ? [peer.path] : [])),
      ),
    ],
    remoteTools: [
      ...new Set(
        peers
          .filter((peer) => peer.peerId !== self.peerId)
          .flatMap((peer) => peer.openTools ?? (peer.activeTool ? [peer.activeTool] : [])),
      ),
    ],
    async undo(path: string, direction: 'undo' | 'redo') {
      if (!enabled || !isTextDocument(path)) return;
      try {
        await actions.current.flushOne(path);
        const record = await actions.current.ensureOpen(path),
          document = record.document;
        if (!document) throw new Error('rpc.fileNotFound');
        const result = await window.blode.collaborationUndo({
          projectRoot: root,
          session: document.session,
          path,
          peerId: self.peerId,
          actorToken,
          requestId: newId(),
          direction,
          scope: studio.isWeb ? 'own' : 'global',
        });
        if (result.status === 'conflict') {
          latest.current.notify(latest.current.t('collaboration.undoConflict'), false, true);
          return;
        }
        actions.current.adopt(result.document);
      } catch (error) {
        latest.current.notify(latest.current.t(error instanceof Error ? error.message : String(error)), true);
      }
    },
    clearPresence() {
      leavePresence();
    },
    async acceptShared(path: string) {
      const record = records.current.get(path);
      if (!record?.document) return;
      if (record.conflict?.disk !== undefined) {
        const document = record.document;
        record.document = await window.blode.collaborationResolve({
          projectRoot: root,
          session: document.session,
          path,
          revision: document.revision,
          content: record.conflict.disk,
          diskContent: record.conflict.disk,
        });
      }
      record.local = record.document.content;
      record.conflict = undefined;
      writeDraft(path, record.local);
      updateConflicts();
    },
    async merge(path: string, content: string) {
      const record = records.current.get(path);
      if (!record?.document) return;
      if (record.conflict?.disk !== undefined) {
        const document = record.document;
        record.document = await window.blode.collaborationResolve({
          projectRoot: root,
          session: document.session,
          path,
          revision: document.revision,
          content,
          diskContent: record.conflict.disk,
        });
      }
      record.local = content;
      record.conflict = undefined;
      writeDraft(path, content);
      updateConflicts();
      await flushOne(path);
    },
  };
}

export type CollaborationWorkspace = ReturnType<typeof useCollaboration>;
