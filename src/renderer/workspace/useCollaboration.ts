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
import type { Studio } from './useStudio';

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
  const closingPaths = useRef(new Set<string>());
  const closingTools = useRef(new Set<string>());
  const presenceActive = useRef(false);
  const previousOpenFiles = useRef<string[]>(studio.openFiles);
  const previousOpenTools = useRef<readonly string[]>(studio.openTools);
  const currentView = useRef<EditorPresence | undefined>(undefined);
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editedAt = useRef(0);
  const root = studio.state?.projectRoot ?? '';
  const enabled = !!root && studio.syncDrafts && typeof window.blode.collaborationState === 'function';
  const updateConflicts = () =>
    setConflicts(
      [...records.current.values()].flatMap((record) => (record.conflict ? [record.conflict] : [])),
    );
  const writeDraft = (path: string, content: string) => {
    const owner = latest.current;
    owner.setDrafts((drafts) => {
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
    if (closingPaths.current.has(path)) throw new Error('rpc.fileNotFound');
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
    if (
      value.projectRoot !== root ||
      (value.presenceRevision !== undefined && value.presenceRevision < receivedPresenceRevision.current)
    )
      return;
    if (value.presenceRevision !== undefined) receivedPresenceRevision.current = value.presenceRevision;
    if (session.current && session.current !== value.session) {
      records.current.clear();
      setConflicts([]);
    }
    session.current = value.session;
    setPeers(value.peers);
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
    if (!enabled || paused.current || owner.state?.projectRoot !== root) return;
    const selected = localTabPresence(
      { ...owner, files: owner.state?.files ?? [] },
      currentView.current,
      closingPaths.current,
      closingTools.current,
    );
    if (!selected) {
      if (presenceActive.current) leavePresence();
      return;
    }
    if (selected.path) currentView.current = selected;
    else currentView.current = undefined;
    presenceActive.current = true;
    const revision = generation.current,
      sequence = ++presenceSequence.current;
    void (selected.path ? actions.current.ensureOpen(selected.path) : Promise.resolve())
      .then(() => {
        if (revision !== generation.current || sequence !== presenceSequence.current || paused.current)
          return;
        return window.blode.collaborationPresence({
          projectRoot: root,
          session: session.current || undefined,
          sequence,
          identity: self,
          actorToken,
          ...selected,
          editing: !!selected.path && Date.now() - editedAt.current < 1800,
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
  const reportPresence = (view: EditorPresence) => {
    const owner = latest.current;
    if (
      !owner.isWeb ||
      paused.current ||
      closingPaths.current.has(view.path) ||
      owner.showHome ||
      owner.view !== 'code' ||
      !owner.openFiles.includes(view.path) ||
      !owner.state?.files.some((file) => file.path === view.path)
    )
      return;
    if (enabled)
      void actions.current.ensureOpen(view.path).catch((error) => setConnectionError(String(error)));
    currentView.current = view;
    clearTimeout(presenceTimer.current);
    presenceTimer.current = setTimeout(sendPresence, 180);
  };
  const reportEdit = (path: string, content: string) => {
    if (!enabled) return;
    editedAt.current = Date.now();
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
  const actions = useRef({ adopt, ensureOpen, flushOne, sendPresence, receiveSnapshot, leavePresence });
  actions.current = { adopt, ensureOpen, flushOne, sendPresence, receiveSnapshot, leavePresence };

  useEffect(() => {
    generation.current++;
    records.current.clear();
    closingPaths.current.clear();
    closingTools.current.clear();
    presenceActive.current = false;
    receivedPresenceRevision.current = -1;
    paused.current = false;
    session.current = '';
    setPeers([]);
    setConflicts([]);
    setConnectionError('');
    if (!enabled) return;
    let disposed = false;
    const snapshot = (value: CollaborationSnapshot) => {
      if (disposed || value.projectRoot !== root) return;
      actions.current.receiveSnapshot(value);
    };
    const unsubscribe = window.blode.onCollaboration((event: CollaborationEvent) => {
      if (disposed) return;
      if (event.type === 'workspace' || event.type === 'presence') snapshot(event.snapshot);
      if (event.type === 'document') actions.current.adopt(event.document, event.requestId);
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
    const initialGeneration = generation.current;
    void window.blode
      .collaborationState()
      .then((value) => {
        if (initialGeneration === generation.current) snapshot(value);
      })
      .catch((error) => setConnectionError(String(error)));
    const heartbeat = setInterval(() => {
      actions.current.sendPresence();
      for (const [path, record] of records.current)
        if (
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
      const paths = [...new Set([...records.current.keys(), ...Object.keys(latest.current.drafts)])];
      for (const path of paths) await actions.current.flushOne(path);
      return Object.fromEntries([...records.current.entries()].map(([path, record]) => [path, record.local]));
    });
    const leave = () => {
      paused.current = true;
      leavePresence();
    };
    const resume = () => {
      paused.current = false;
      const sequence = ++presenceSequence.current;
      void window.blode
        .collaborationState()
        .then((value) => {
          if (disposed || sequence !== presenceSequence.current || value.projectRoot !== root) return;
          // A restarted host has a new session and restarts its snapshot counter.
          if (session.current && session.current !== value.session) {
            generation.current++;
            receivedPresenceRevision.current = -1;
            records.current.clear();
            setConflicts([]);
          }
          actions.current.receiveSnapshot(value);
          actions.current.sendPresence();
        })
        .catch((error) => {
          if (!disposed) setConnectionError(String(error));
        });
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', resume);
    window.addEventListener('blode:collaboration-reconnect', resume);
    return () => {
      disposed = true;
      generation.current++;
      unsubscribe();
      unregister();
      leave();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('blode:collaboration-reconnect', resume);
      clearInterval(heartbeat);
      clearTimeout(presenceTimer.current);
    };
  }, [root, enabled, self.peerId, studio.isWeb]);
  useEffect(() => {
    if (!enabled) return;
    const paths = [...new Set([studio.activePath, ...Object.keys(studio.drafts)])].filter(Boolean);
    for (const path of paths)
      void actions.current.ensureOpen(path).catch((error) => setConnectionError(String(error)));
  }, [root, enabled, studio.activePath]);
  useEffect(() => {
    if (!enabled) return;
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
    enabled,
    studio.isWeb,
    studio.openFiles,
    studio.openTools,
    studio.activePath,
    studio.showHome,
    studio.view,
  ]);
  useEffect(() => {
    if (!enabled) return;
    const unregister = registerFileCloseHandler(async (requestRoot, path, decision) => {
      if (requestRoot !== root) return false;
      const record = records.current.get(path);
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
    });
    const closed = (event: Event) => {
      const detail = (event as CustomEvent<{ root: string; path: string }>).detail;
      if (detail?.root !== root) return;
      closingPaths.current.add(detail.path);
      records.current.delete(detail.path);
      updateConflicts();
      if (currentView.current?.path === detail.path) actions.current.leavePresence();
      actions.current.sendPresence();
    };
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
      window.removeEventListener('blode:tool-closed', toolClosed);
    };
  }, [root, enabled]);

  return {
    peers: peers.filter((peer) => peer.peerId !== self.peerId),
    allPeers: peers,
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
      if (!enabled) return;
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
