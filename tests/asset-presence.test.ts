import assert from 'node:assert/strict';
import test from 'node:test';
import { CollaborationService, type CollaborationWorkspace } from '../src/core/collaboration';
import type { CollaborationPresenceInput } from '../src/shared/collaboration';
import { localTabPresence } from '../src/renderer/workspace/localPresence';

const credential = 'a'.repeat(64);
function fixture() {
  const workspace: CollaborationWorkspace = {
    projectRoot: '/project',
    files: [
      { path: 'main.c', content: 'int value;' },
      { path: 'assets/logo.svg', content: '<svg/>' },
    ],
    inventory: {
      entries: [
        { path: 'assets', kind: 'directory' },
        { path: 'assets/logo.webp', kind: 'file' },
        { path: 'assets/logo.svg', kind: 'file' },
        { path: 'assets/music.mp3', kind: 'file' },
        { path: 'assets/firmware.bin', kind: 'file' },
      ],
    },
  };
  const writes: string[] = [];
  const service = new CollaborationService({
    workspace: async () => structuredClone(workspace),
    saveFile: async (path) => {
      writes.push(path);
    },
    publish() {},
  });
  const presence = (
    sequence: number,
    values: Partial<CollaborationPresenceInput> = {},
  ): CollaborationPresenceInput => ({
    projectRoot: workspace.projectRoot,
    identity: { peerId: 'alice-page', userId: 'alice', name: 'Alice' },
    actorToken: credential,
    sequence,
    path: 'assets/logo.webp',
    openPaths: ['assets/logo.webp', 'assets/music.mp3', 'assets', 'missing.png'],
    clientKind: 'web',
    startLine: 64,
    endLine: 84,
    cursor: { line: 70, column: 8 },
    editing: true,
    ...values,
  });
  return { workspace, service, presence, writes };
}

test('resource tabs share viewing presence without creating text documents or edit ranges', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const result = await f.service.presence(f.presence(1), false);
  const peer = result.peers[0];
  assert.equal(peer.path, 'assets/logo.webp');
  assert.deepEqual(peer.openPaths, ['assets/logo.webp', 'assets/music.mp3']);
  assert.equal(peer.startLine, 1);
  assert.equal(peer.endLine, 1);
  assert.equal(peer.cursor, undefined);
  assert.equal(peer.editing, false);
  assert.deepEqual(result.documents, []);
  assert.equal((await f.service.state()).peers[0].path, 'assets/logo.webp');
});

test('media and binary inventory paths cannot enter collaborative text open, edit or save', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const state = await f.service.presence(f.presence(1), false);
  for (const path of ['assets/logo.webp', 'assets/music.mp3', 'assets/firmware.bin']) {
    await assert.rejects(f.service.open('/project', path), /fileNotFound/);
    await assert.rejects(
      f.service.edit(
        {
          projectRoot: '/project',
          session: state.session,
          path,
          actorToken: credential,
          peerId: 'alice-page',
          requestId: path.replaceAll('/', '-'),
          baseRevision: 0,
          changes: [{ start: 0, end: 0, text: 'overwrite' }],
        },
        false,
      ),
      /fileNotFound/,
    );
    await assert.rejects(
      f.service.save({
        projectRoot: '/project',
        session: state.session,
        path,
        revision: 0,
      }),
      /fileNotFound/,
    );
    await assert.rejects(f.service.writeFile('/project', path, 'overwrite'), /fileType/);
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual((await f.service.state()).documents, []);
  assert.equal((await f.service.open('/project', 'main.c')).content, 'int value;');
  assert.equal((await f.service.open('/project', 'assets/logo.svg')).content, '<svg/>');
});

test('desktop media viewing is shared while desktop source coordinates remain private', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const asset = await f.service.presence(f.presence(1, { clientKind: 'desktop' }));
  assert.equal(asset.peers[0].path, 'assets/logo.webp');
  assert.equal(asset.peers[0].editing, false);
  assert.equal(asset.peers[0].cursor, undefined);
  const code = await f.service.presence(
    f.presence(2, {
      path: 'main.c',
      clientKind: 'desktop',
      openPaths: ['main.c', 'assets/music.mp3'],
    }),
  );
  assert.equal(code.peers[0].path, '');
  assert.deepEqual(code.peers[0].openPaths, ['main.c', 'assets/music.mp3']);
});

test('deleted assets and closed media tabs release their peers without late resurrection', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.presence(f.presence(1, { openPaths: ['assets/logo.webp', 'main.c'] }), false);
  f.workspace.inventory!.entries = f.workspace.inventory!.entries.filter(
    (entry) => entry.path !== 'assets/logo.webp',
  );
  const retained = (await f.service.state()).peers[0];
  assert.equal(retained.path, '');
  assert.deepEqual(retained.openPaths, ['main.c']);
  assert.equal(retained.editing, false);
  await f.service.presence(f.presence(2, { path: '', openPaths: [] }), false);
  assert.equal((await f.service.presence(f.presence(1), false)).peers.length, 0);
  await assert.rejects(f.service.presence(f.presence(3), false), /fileNotFound/);
  assert.equal((await f.service.state()).peers.length, 0);
});

test('media background and restore snapshots retain tabs but release active viewing', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.presence(f.presence(1), false);
  const inactive = await f.service.presence(f.presence(2, { attention: 'inactive', path: '' }), false);
  assert.equal(inactive.peers[0].path, '');
  assert.equal(inactive.peers[0].editing, false);
  assert.deepEqual(inactive.peers[0].openPaths, ['assets/logo.webp', 'assets/music.mp3']);
  const active = await f.service.presence(f.presence(3, { attention: 'active' }), false);
  assert.equal(active.peers[0].path, 'assets/logo.webp');
  assert.equal(active.peers[0].startLine, 1);
  assert.equal(
    (await f.service.presence(f.presence(2, { attention: 'inactive' }), false)).peers[0].attention,
    'active',
  );
});

const empty = new Set<string>();
const localOwner = (isWeb: boolean) => ({
  isWeb,
  showHome: false,
  view: 'code',
  activePath: 'assets/music.mp3',
  openFiles: ['assets/music.mp3', 'main.c'],
  openTools: [],
  files: [{ path: 'main.c' }],
  inventory: { entries: [{ path: 'assets/music.mp3', kind: 'file' as const }] },
});

test('local resource presence ignores old editor coordinates on desktop and browser', () => {
  for (const isWeb of [true, false]) {
    const presence = localTabPresence(
      localOwner(isWeb),
      {
        ownerPath: 'assets/music.mp3',
        path: 'main.c',
        startLine: 70,
        endLine: 80,
        cursor: { line: 73, column: 2 },
      },
      empty,
      empty,
    )!;
    assert.equal(presence.path, 'assets/music.mp3');
    assert.equal(presence.startLine, 1);
    assert.equal(presence.endLine, 1);
    assert.equal(presence.cursor, undefined);
    assert.deepEqual(presence.openPaths, ['assets/music.mp3', 'main.c']);
  }
});

test('closing a resource does not fall through to a stale split editor viewport', () => {
  const presence = localTabPresence(
    localOwner(true),
    {
      ownerPath: 'assets/music.mp3',
      path: 'main.c',
      startLine: 70,
      endLine: 80,
    },
    new Set(['assets/music.mp3']),
    empty,
  )!;
  assert.equal(presence.path, '');
  assert.deepEqual(presence.openPaths, ['main.c']);
  assert.equal(
    localTabPresence(localOwner(true), undefined, new Set(['assets/music.mp3', 'main.c']), empty),
    null,
  );
  const home = localTabPresence({ ...localOwner(true), showHome: true }, undefined, empty, empty)!;
  assert.equal(home.path, '');
  assert.equal(home.cursor, undefined);
  assert.deepEqual(home.openPaths, ['assets/music.mp3', 'main.c']);
});
