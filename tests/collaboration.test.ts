import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CollaborationService,
  normalizeCollaborationPath,
  transformCollaborationChanges,
  type CollaborationWorkspace,
} from '../src/core/collaboration';
import {
  COLLABORATION_COLORS,
  type CollaborationDocument,
  type CollaborationEvent,
} from '../src/shared/collaboration';
import type { CollaborationUndoRequest } from '../src/shared/collaboration';

function fixture(content = 'alpha\nbeta\ngamma\n') {
  let workspace: CollaborationWorkspace = {
    projectRoot: 'C:/project',
    files: [
      { path: 'main.c', content },
      { path: 'other.c', content: 'other' },
    ],
  };
  let cached = workspace;
  let clock = Date.now();
  const events: CollaborationEvent[] = [];
  const writes: { path: string; content: string }[] = [];
  const service = new CollaborationService({
    workspace: async () => structuredClone(cached),
    freshWorkspace: async () => structuredClone(workspace),
    now: () => clock,
    publish: (event) => events.push(event),
    saveFile: async (path, content) => {
      const file = workspace.files.find((item) => item.path === path);
      if (file) file.content = content;
      else workspace.files.push({ path, content });
      writes.push({ path, content });
      cached = structuredClone(workspace);
    },
  });
  let request = 0;
  const edit = (
    doc: CollaborationDocument,
    start: number,
    end: number,
    text: string,
    peerId = 'peer-a',
    requestId = `request-${++request}`,
  ) =>
    service.edit({
      projectRoot: doc.projectRoot,
      session: doc.session,
      path: doc.path,
      peerId,
      requestId,
      baseRevision: doc.revision,
      changes: [{ start, end, text }],
    });
  return {
    service,
    events,
    writes,
    edit,
    workspace: () => workspace,
    setWorkspace: (next: CollaborationWorkspace) => {
      workspace = next;
      cached = structuredClone(next);
    },
    advance: (ms: number) => {
      clock += ms;
    },
    refreshCache: () => {
      cached = structuredClone(workspace);
    },
  };
}

const actorA = 'a'.repeat(64),
  actorB = 'b'.repeat(64);
function undoRequest(
  doc: CollaborationDocument,
  peerId: string,
  actorToken: string,
  direction: 'undo' | 'redo' = 'undo',
  scope: 'own' | 'global' = 'own',
): CollaborationUndoRequest {
  return {
    projectRoot: doc.projectRoot,
    session: doc.session,
    path: doc.path,
    peerId,
    actorToken,
    requestId: `undo-${crypto.randomUUID()}`,
    direction,
    scope,
  };
}

test('browser undo and redo remove only its own edit across later independent remote changes', async (t) => {
  const f = fixture('alpha beta');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  doc = (
    await f.service.edit(
      {
        projectRoot: doc.projectRoot,
        session: doc.session,
        path: doc.path,
        peerId: 'alice',
        actorToken: actorA,
        requestId: 'a1',
        baseRevision: doc.revision,
        changes: [{ start: 0, end: 5, text: 'ALPHA' }],
      },
      false,
    )
  ).document;
  doc = (
    await f.service.edit(
      {
        projectRoot: doc.projectRoot,
        session: doc.session,
        path: doc.path,
        peerId: 'bob',
        actorToken: actorB,
        requestId: 'b1',
        baseRevision: doc.revision,
        changes: [{ start: 6, end: 10, text: 'BETA' }],
      },
      false,
    )
  ).document;
  const undo = undoRequest(doc, 'alice', actorA);
  const result = await f.service.undo(undo, false);
  assert.equal(result.status, 'applied');
  assert.equal(result.document.content, 'alpha BETA');
  assert.deepEqual(await f.service.undo(undo, false), result, 'retries cannot undo another operation');
  const redo = await f.service.undo(undoRequest(result.document, 'alice', actorA, 'redo'), false);
  assert.equal(redo.document.content, 'ALPHA BETA');
});

test('browser cannot request global undo or impersonate another peer', async (t) => {
  const f = fixture('abc');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  const base = {
    projectRoot: doc.projectRoot,
    session: doc.session,
    path: doc.path,
    peerId: 'alice',
    actorToken: actorA,
    requestId: 'a1',
    baseRevision: doc.revision,
    changes: [{ start: 0, end: 1, text: 'A' }],
  };
  doc = (await f.service.edit(base, false)).document;
  await assert.rejects(
    () => f.service.undo(undoRequest(doc, 'alice', actorA, 'undo', 'global'), false),
    /GlobalUndoForbidden/,
  );
  await assert.rejects(() => f.service.undo(undoRequest(doc, 'alice', actorB), false), /ActorMismatch/);
  await assert.rejects(
    () => f.service.edit({ ...base, requestId: 'spoof', actorToken: actorB }, false),
    /ActorMismatch/,
  );
  await assert.rejects(
    () =>
      f.service.presence(
        {
          projectRoot: doc.projectRoot,
          identity: { peerId: 'alice', userId: 'other', name: 'fake' },
          path: 'main.c',
          startLine: 1,
          endLine: 1,
          editing: false,
          actorToken: actorB,
        },
        false,
      ),
    /ActorMismatch/,
  );
  await assert.rejects(
    () => f.service.edit({ ...base, peerId: 'no-secret', actorToken: undefined }, false),
    /ActorRequired/,
  );
  assert.ok(!JSON.stringify(await f.service.state()).includes(actorA));
  assert.ok(!JSON.stringify(f.events).includes(actorA));
  assert.equal((await f.service.open(doc.projectRoot, doc.path)).content, 'Abc');
});

test('trusted desktop global undo may undo the newest other-author edit', async (t) => {
  const f = fixture('abc');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  doc = (await f.edit(doc, 0, 1, 'A', 'alice')).document;
  doc = (await f.edit(doc, 2, 3, 'C', 'bob')).document;
  const result = await f.service.undo(undoRequest(doc, 'desktop', actorA, 'undo', 'global'), true);
  assert.equal(result.document.content, 'Abc');
  const second = await f.service.undo(
    undoRequest(result.document, 'desktop', actorA, 'undo', 'global'),
    true,
  );
  assert.equal(second.document.content, 'abc');
});

test('adjacent own typing groups together, redo survives a boundary remote insertion', async (t) => {
  const f = fixture('');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  doc = (await f.edit(doc, 0, 0, 'a', 'alice')).document;
  f.advance(100);
  doc = (await f.edit(doc, 1, 1, 'b', 'alice')).document;
  let result = await f.service.undo({ ...undoRequest(doc, 'alice', actorA), actorToken: undefined }, true);
  assert.equal(result.document.content, '');
  doc = (await f.edit(result.document, 0, 0, 'remote', 'bob')).document;
  result = await f.service.undo(
    { ...undoRequest(doc, 'alice', actorA, 'redo'), actorToken: undefined },
    true,
  );
  assert.equal(result.document.content, 'remoteab');
});

test('successive own replacements can be undone separately after typing pauses', async (t) => {
  const f = fixture('a');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  doc = (await f.edit(doc, 0, 1, 'b', 'alice')).document;
  f.advance(1000);
  doc = (await f.edit(doc, 0, 1, 'c', 'alice')).document;
  let result = await f.service.undo({ ...undoRequest(doc, 'alice', actorA), actorToken: undefined }, true);
  assert.equal(result.document.content, 'b');
  result = await f.service.undo(
    { ...undoRequest(result.document, 'alice', actorA), actorToken: undefined },
    true,
  );
  assert.equal(result.status, 'applied');
  assert.equal(result.document.content, 'a');
});

test('new edits clear redo without losing proof of a canceled overlapping action', async (t) => {
  const f = fixture('ab');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  doc = (await f.edit(doc, 0, 1, 'A', 'alice')).document;
  f.advance(1000);
  doc = (await f.edit(doc, 0, 1, 'B', 'alice')).document;
  doc = (await f.service.undo({ ...undoRequest(doc, 'alice', actorA), actorToken: undefined }, true))
    .document;
  f.advance(1000);
  doc = (await f.edit(doc, 1, 2, 'C', 'alice')).document;
  doc = (await f.service.undo({ ...undoRequest(doc, 'alice', actorA), actorToken: undefined }, true))
    .document;
  const result = await f.service.undo({ ...undoRequest(doc, 'alice', actorA), actorToken: undefined }, true);
  assert.equal(result.status, 'applied');
  assert.equal(result.document.content, 'ab');
});

test('overlapping paused actions can both redo through repeated undo redo cycles', async (t) => {
  const f = fixture('base');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  doc = (await f.edit(doc, 0, 4, 'longer text', 'alice')).document;
  f.advance(1000);
  doc = (await f.edit(doc, 0, 11, 'short', 'alice')).document;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const [direction, content] of [
      ['undo', 'longer text'],
      ['undo', 'base'],
      ['redo', 'longer text'],
      ['redo', 'short'],
    ] as const) {
      const result = await f.service.undo(
        { ...undoRequest(doc, 'alice', actorA, direction), actorToken: undefined },
        true,
      );
      assert.equal(result.status, 'applied');
      assert.equal(result.document.content, content);
      doc = result.document;
    }
  }
});

test('own undo refuses to delete another author replacement within its changed range', async (t) => {
  const f = fixture('a');
  t.after(() => f.service.dispose());
  let doc = await f.service.open('C:/project', 'main.c');
  doc = (await f.edit(doc, 0, 1, 'hello', 'alice')).document;
  doc = (await f.edit(doc, 1, 3, 'XX', 'bob')).document;
  const result = await f.service.undo({ ...undoRequest(doc, 'alice', actorA), actorToken: undefined }, true);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'overlap');
  assert.equal(result.document.content, 'hXXlo');
});

test('presence publishes all allowed open tabs without leaking its private actor token', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const snapshot = await f.service.presence(
    {
      projectRoot: 'C:/project',
      identity: { userId: 'alice', peerId: 'tab-a', name: 'Alice' },
      actorToken: actorA,
      path: 'main.c',
      openPaths: ['main.c', 'other.c'],
      startLine: 1,
      endLine: 2,
      editing: false,
    },
    false,
  );
  assert.deepEqual(snapshot.peers[0].openPaths, ['main.c', 'other.c']);
  assert.ok(!JSON.stringify(snapshot).includes(actorA));
});

test('concurrent independent edits rebase without overwriting either user', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const first = await f.edit(original, 0, 0, '// first\n');
  const second = await f.edit(original, 6, 10, 'BETA', 'peer-b');
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'applied');
  assert.equal(second.document.content, '// first\nalpha\nBETA\ngamma\n');
  assert.equal(second.document.revision, 2);
  assert.equal(second.document.dirty, true);
  assert.equal(f.writes.length, 0, 'collaboration edits remain unsaved');
});

test('simultaneous insertions at one offset preserve both edits deterministically', async (t) => {
  const f = fixture('');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  await f.edit(original, 0, 0, 'A');
  await f.edit(original, 0, 0, 'B', 'peer-b');
  const third = await f.edit(original, 0, 0, 'C', 'peer-c');
  assert.equal(third.document.content, 'ABC');
});

test('overlapping replacements report conflict and leave shared text untouched', async (t) => {
  const f = fixture('abcdef');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  await f.edit(original, 1, 4, 'ABC');
  const result = await f.edit(original, 2, 5, 'mine', 'peer-b');
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'overlap');
  assert.equal(result.document.content, 'aABCef');
  assert.equal((await f.service.open('C:/project', 'main.c')).revision, 1);
});

test('request retry is idempotent; changing a reused request ID is rejected', async (t) => {
  const f = fixture('abc');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const first = await f.edit(original, 0, 0, 'x', 'desktop-peer', 'retry-1');
  const retry = await f.edit(original, 0, 0, 'x', 'desktop-peer', 'retry-1');
  assert.deepEqual(first, retry);
  await assert.rejects(
    () => f.edit(original, 0, 0, 'changed', 'desktop-peer', 'retry-1'),
    /rpc.invalidParams/,
  );
  assert.equal((await f.service.open('C:/project', 'main.c')).content, 'xabc');
});

test('history expiry returns an explicit conflict instead of guessing offsets', async (t) => {
  const f = fixture('');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  let current = original;
  for (let index = 0; index < 257; index++)
    current = (await f.edit(current, current.content.length, current.content.length, 'a')).document;
  const result = await f.edit(original, 0, 0, 'old', 'peer-b');
  assert.equal(result.reason, 'historyExpired');
  assert.equal(result.status, 'conflict');
  assert.equal(result.document.content.length, 257);
});

test('old project and session cannot write after a workspace transition', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  f.setWorkspace({ projectRoot: 'C:/another', files: [{ path: 'main.c', content: 'new' }] });
  await assert.rejects(() => f.edit(original, 0, 0, 'bad'), /collaborationProjectChanged/);
  const next = await f.service.open('C:/another', 'main.c');
  assert.notEqual(next.session, original.session);
  assert.equal(next.content, 'new');
  assert.equal((await f.service.state()).peers.length, 0);
});

test('presence colors are stable per user, paths are allowlisted, and offline peers expire', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const input = {
    projectRoot: 'C:/project',
    identity: { userId: 'browser-user', peerId: 'tab-one', name: 'Reader', color: COLLABORATION_COLORS[0] },
    path: 'main.c',
    startLine: 64,
    endLine: 84,
    editing: false,
  };
  await f.service.presence(input);
  const state = await f.service.presence({
    ...input,
    identity: { ...input.identity, peerId: 'tab-two', color: COLLABORATION_COLORS[1] },
  });
  assert.equal(state.peers[0].color, state.peers[1].color);
  assert.equal(state.peers[0].startLine, 64);
  assert.equal(state.peers[0].endLine, 84);
  assert.deepEqual(state.documents, [], 'presence snapshots contain no file contents');
  await assert.rejects(() => f.service.presence({ ...input, path: 'missing.c' }), /fileNotFound/);
  f.advance(46_000);
  assert.equal((await f.service.state()).peers.length, 0);
  assert.equal(f.events.at(-1)?.type, 'presence');
});

test('fresh disk checks prevent saving over external edits during cache debounce', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const edited = (await f.edit(original, 0, 3, 'shared')).document;
  f.workspace().files[0].content = 'external'; // Intentionally leave the normal read cache stale.
  await assert.rejects(
    () =>
      f.service.save({
        projectRoot: edited.projectRoot,
        session: edited.session,
        path: edited.path,
        revision: edited.revision,
      }),
    /collaborationDiskChanged/,
  );
  assert.equal(f.writes.length, 0);
  f.refreshCache();
  const conflict = await f.edit(edited, 0, 0, 'x');
  assert.equal(conflict.reason, 'diskChanged');
  assert.equal(conflict.diskContent, 'external');
  assert.equal(conflict.document.content, 'shared');
});

test('flush checks every dirty document before writing any document', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const a = await f.service.open('C:/project', 'main.c');
  const b = await f.service.open('C:/project', 'other.c');
  await f.edit(a, 0, 0, 'a');
  await f.edit(b, 0, 0, 'b');
  f.workspace().files[1].content = 'external';
  await assert.rejects(() => f.service.flush(), /collaborationDiskChanged/);
  assert.equal(f.writes.length, 0);
});

test('save checks revision and legacy writes cannot replace another shared draft', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const changed = (await f.edit(original, 0, 3, 'new')).document;
  await assert.rejects(
    () =>
      f.service.save({
        projectRoot: original.projectRoot,
        session: original.session,
        path: original.path,
        revision: original.revision,
      }),
    /collaborationSaveConflict/,
  );
  await assert.rejects(
    () => f.service.writeFile('C:/project', 'main.c', 'overwrite'),
    /collaborationSaveConflict/,
  );
  const saved = await f.service.save({
    projectRoot: changed.projectRoot,
    session: changed.session,
    path: changed.path,
    revision: changed.revision,
  });
  assert.equal(saved.dirty, false);
  assert.equal(saved.content, 'new');
  assert.deepEqual(f.writes, [{ path: 'main.c', content: 'new' }]);
});

test('disk conflict resolution requires the reviewed disk content and revision', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const changed = (await f.edit(original, 0, 3, 'mine')).document;
  f.workspace().files[0].content = 'disk';
  const request = {
    projectRoot: changed.projectRoot,
    session: changed.session,
    path: changed.path,
    revision: changed.revision,
    content: 'mine + disk',
    diskContent: 'disk',
  };
  await assert.rejects(
    () => f.service.resolve({ ...request, diskContent: 'old' }),
    /collaborationSaveConflict/,
  );
  const resolved = await f.service.resolve(request);
  assert.equal(resolved.dirty, true);
  assert.equal(f.writes.length, 0);
  const saved = await f.service.save({
    projectRoot: resolved.projectRoot,
    session: resolved.session,
    path: resolved.path,
    revision: resolved.revision,
  });
  assert.equal(saved.content, 'mine + disk');
  assert.equal(f.workspace().files[0].content, 'mine + disk');
});

test('edit offsets are UTF-16 and malformed or overlapping batches are rejected', async (t) => {
  const f = fixture('😀abc');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const result = await f.edit(original, 2, 3, 'A');
  assert.equal(result.document.content, '😀Abc');
  await assert.rejects(() => f.edit(result.document, 5, 4, 'x'), /invalidParams/);
  await assert.rejects(
    () =>
      f.service.edit({
        projectRoot: original.projectRoot,
        session: original.session,
        path: original.path,
        peerId: 'p',
        requestId: 'invalid',
        baseRevision: 1,
        changes: [
          { start: 0, end: 3, text: '' },
          { start: 2, end: 4, text: '' },
        ],
      }),
    /invalidParams/,
  );
});

test('path validation rejects traversal and pure transform handles insertion boundaries', () => {
  assert.equal(normalizeCollaborationPath('src\\main.c'), 'src/main.c');
  for (const value of ['../secret', '/main.c', 'C:/main.c', 'a/./b', 'a//b', 'a\0b'])
    assert.throws(() => normalizeCollaborationPath(value));
  assert.deepEqual(
    transformCollaborationChanges([{ start: 2, end: 4, text: '' }], [{ start: 2, end: 2, text: 'x' }]),
    [{ start: 3, end: 5, text: '' }],
  );
  assert.deepEqual(
    transformCollaborationChanges([{ start: 2, end: 4, text: '' }], [{ start: 4, end: 4, text: 'x' }]),
    [{ start: 2, end: 4, text: '' }],
  );
  assert.equal(
    transformCollaborationChanges([{ start: 2, end: 4, text: '' }], [{ start: 3, end: 3, text: 'x' }]),
    null,
  );
});

test('legacy file writes preserve creating new files through the guarded core callback', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.writeFile('C:/project', 'src\\new.c', 'int main() {}');
  assert.deepEqual(f.writes, [{ path: 'src/new.c', content: 'int main() {}' }]);
  assert.equal((await f.service.open('C:/project', 'src/new.c')).content, 'int main() {}');
  await assert.rejects(() => f.service.writeFile('C:/project', '../escape.c', 'bad'), /invalidPath/);
});

test('legacy writes never recreate a deleted file with a known shared draft', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const changed = (await f.edit(original, 0, 3, 'shared')).document;
  f.workspace().files = f.workspace().files.filter((file) => file.path !== 'main.c');
  await assert.rejects(
    () => f.service.writeFile('C:/project', 'main.c', changed.content),
    /collaborationDiskChanged/,
  );
  assert.equal(f.writes.length, 0);
  assert.equal((await f.service.state()).documents.find((doc) => doc.path === 'main.c')?.dirty, true);
});

test('a clean shared file deleted on disk may be explicitly recreated by legacy save', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  await f.service.open('C:/project', 'main.c');
  f.workspace().files = f.workspace().files.filter((file) => file.path !== 'main.c');
  await f.service.writeFile('C:/project', 'main.c', 'recreated');
  assert.deepEqual(f.writes, [{ path: 'main.c', content: 'recreated' }]);
});

test('workspace transitions save existing drafts then reject queued old-session edits', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  const changed = (await f.edit(original, 0, 3, 'saved draft')).document;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transition = f.service.workspaceAction(async () => {
    assert.equal(f.workspace().files[0].content, 'saved draft');
    entered();
    await waiting;
    f.setWorkspace({ projectRoot: 'C:/new-project', files: [{ path: 'main.c', content: 'new project' }] });
    return 'opened';
  });
  await started;
  const queued = f.edit(changed, 0, 0, 'late');
  release();
  assert.equal(await transition, 'opened');
  await assert.rejects(() => queued, /collaborationProjectChanged/);
  assert.equal(f.writes.length, 1);
  assert.equal((await f.service.open('C:/new-project', 'main.c')).content, 'new project');
});

test('workspace actions stop before moving files when an external disk conflict exists', async (t) => {
  const f = fixture('old');
  t.after(() => f.service.dispose());
  const original = await f.service.open('C:/project', 'main.c');
  await f.edit(original, 0, 3, 'draft');
  f.workspace().files[0].content = 'external';
  let moved = false;
  await assert.rejects(
    () =>
      f.service.workspaceAction(async () => {
        moved = true;
      }),
    /collaborationDiskChanged/,
  );
  assert.equal(moved, false);
  assert.equal(f.writes.length, 0);
});
