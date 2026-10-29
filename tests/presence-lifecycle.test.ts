import assert from 'node:assert/strict';
import test from 'node:test';
import { CollaborationService } from '../src/core/collaboration';
import type { CollaborationPresenceInput } from '../src/shared/collaboration';

const token = 'a'.repeat(64);
function fixture(count = 2) {
  const workspace = {
    projectRoot: '/workspace',
    files: Array.from({ length: count }, (_, i) => ({ path: `file${i}.c`, content: `int value${i};\n` })),
  };
  const service = new CollaborationService({
    workspace: async () => structuredClone(workspace),
    saveFile: async (path, content) => {
      workspace.files.find((file) => file.path === path)!.content = content;
    },
    publish: () => {},
  });
  const presence = (sequence: number, path = 'file0.c', openPaths = [path]): CollaborationPresenceInput => ({
    projectRoot: workspace.projectRoot,
    identity: { peerId: 'alice', userId: 'alice', name: 'Alice' },
    actorToken: token,
    sequence,
    path,
    startLine: 1,
    endLine: 1,
    editing: false,
    openPaths,
  });
  return { service, workspace, presence };
}

test('late presence and obsolete leave cannot recreate a closed peer or remove its newer lease', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const first = await f.service.presence(f.presence(1), false);
  await f.service.leave({ peerId: 'alice', actorToken: token, sequence: 2 }, false);
  const late = await f.service.presence(f.presence(1), false);
  assert.equal(late.peers.length, 0);
  assert.ok(late.presenceRevision! > first.presenceRevision!);
  await f.service.presence(f.presence(3, 'file1.c'), false);
  await f.service.leave({ peerId: 'alice', actorToken: token, sequence: 2 }, false);
  assert.equal((await f.service.state()).peers[0].path, 'file1.c');
  await f.service.leave({ peerId: 'alice', actorToken: token, sequence: 3 }, false);
  assert.equal((await f.service.presence(f.presence(3), false)).peers.length, 0);
  assert.equal((await f.service.presence(f.presence(4), false)).peers.length, 1);
});

test('peer release requires its credential and stale workspace releases are harmless', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const state = await f.service.presence(f.presence(1), false);
  await assert.rejects(() => f.service.leave('alice', false), /ActorRequired/);
  await assert.rejects(
    () => f.service.leave({ peerId: 'alice', actorToken: 'b'.repeat(64), sequence: 2 }, false),
    /ActorMismatch/,
  );
  await f.service.leave(
    { peerId: 'alice', actorToken: token, projectRoot: '/old-project', session: state.session, sequence: 99 },
    false,
  );
  assert.equal((await f.service.state()).peers.length, 1);
  await f.service.leave('alice');
  assert.equal((await f.service.state()).peers.length, 0);
});

test('browsing hundreds of files recycles immutable cached documents and fences stale edits', async (t) => {
  const f = fixture(360);
  t.after(() => f.service.dispose());
  const original = await f.service.open('/workspace', 'file0.c');
  await f.service.presence(
    f.presence(
      1,
      'file359.c',
      f.workspace.files.slice(0, 256).map((file) => file.path),
    ),
    false,
  );
  for (let i = 1; i < 360; i++) await f.service.open('/workspace', `file${i}.c`);
  const reopened = await f.service.open('/workspace', 'file0.c');
  assert.ok(reopened.revision > original.revision);
  const result = await f.service.edit(
    {
      projectRoot: '/workspace',
      session: original.session,
      path: original.path,
      peerId: 'alice',
      actorToken: token,
      requestId: 'stale',
      baseRevision: original.revision,
      changes: [{ start: 0, end: 3, text: 'bad' }],
    },
    false,
  );
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'historyExpired');
  assert.equal(result.document.content, original.content);
  assert.ok((await f.service.state()).documents.length <= 128);
});

test('cache recycling preserves dirty text and saved undo history', async (t) => {
  const f = fixture(300);
  t.after(() => f.service.dispose());
  const edit = async (path: string, id: string) => {
    const doc = await f.service.open('/workspace', path);
    return (
      await f.service.edit(
        {
          projectRoot: '/workspace',
          session: doc.session,
          path,
          peerId: 'alice',
          actorToken: token,
          requestId: id,
          baseRevision: doc.revision,
          changes: [{ start: 0, end: 3, text: 'volatile' }],
        },
        false,
      )
    ).document;
  };
  const dirty = await edit('file0.c', 'dirty');
  const saved = await edit('file1.c', 'saved');
  await f.service.save({
    projectRoot: '/workspace',
    session: saved.session,
    path: saved.path,
    revision: saved.revision,
  });
  for (let i = 2; i < 300; i++) await f.service.open('/workspace', `file${i}.c`);
  assert.equal((await f.service.open('/workspace', 'file0.c')).content, dirty.content);
  const undone = await f.service.undo(
    {
      projectRoot: '/workspace',
      session: saved.session,
      path: saved.path,
      peerId: 'alice',
      actorToken: token,
      requestId: 'undo-saved',
      direction: 'undo',
    },
    false,
  );
  assert.equal(undone.status, 'applied');
  assert.equal(undone.document.content, 'int value1;\n');
});

test('stale background tabs do not invalidate the current live viewport', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const result = await f.service.presence(f.presence(1, 'file0.c', ['file1.c', 'deleted.c']), false);
  assert.deepEqual(result.peers[0].openPaths, ['file0.c', 'file1.c']);
});
