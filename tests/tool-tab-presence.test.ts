import assert from 'node:assert/strict';
import test from 'node:test';
import { CollaborationService } from '../src/core/collaboration';
import { collaborationSchemas } from '../src/core/collaboration-schemas';
import type { CollaborationPresenceInput, CollaborationToolTab } from '../src/shared/collaboration';
import { localTabPresence } from '../src/renderer/workspace/localPresence';

const credential = 'a'.repeat(64);
function fixture() {
  let now = 1_000_000;
  const workspace = {
    projectRoot: '/project',
    files: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
  };
  const manager = new CollaborationService({
    workspace: async () => structuredClone(workspace),
    publish: () => {},
    now: () => now,
  });
  const presence = (
    sequence: number,
    values: Partial<CollaborationPresenceInput> = {},
  ): CollaborationPresenceInput => ({
    projectRoot: '/project',
    actorToken: credential,
    identity: { userId: 'alice', peerId: 'alice-page', name: 'Alice' },
    sequence,
    path: 'main.c',
    startLine: 64,
    endLine: 84,
    editing: false,
    openPaths: ['main.c'],
    ...values,
  });
  return {
    manager,
    workspace,
    presence,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('resource layout and AI tabs remain present without any open source document', async (t) => {
  const f = fixture();
  t.after(() => f.manager.dispose());
  f.workspace.files = [];
  const result = await f.manager.presence(
    f.presence(1, {
      path: '',
      openPaths: [],
      openTools: ['layout', 'ai'],
      activeTool: 'layout',
      clientKind: 'web',
    }),
    false,
  );
  assert.equal(result.peers.length, 1);
  assert.deepEqual(result.peers[0].openTools, ['layout', 'ai']);
  assert.equal(result.peers[0].activeTool, 'layout');
  assert.equal(result.peers[0].path, '');
  assert.equal(result.peers[0].editing, false);
  assert.equal((await f.manager.state()).peers.length, 1);
  f.advance(45_001);
  assert.equal((await f.manager.state()).peers.length, 0);
});

test('desktop tab metadata shares files and tools without exposing code viewport or cursor', async (t) => {
  const f = fixture();
  t.after(() => f.manager.dispose());
  const state = await f.manager.presence(
    f.presence(1, {
      clientKind: 'desktop',
      editing: true,
      cursor: { line: 80, column: 3 },
      openTools: ['layout'],
    }),
  );
  const peer = state.peers[0];
  assert.equal(peer.clientKind, 'desktop');
  assert.equal(peer.path, '');
  assert.equal(peer.startLine, 1);
  assert.equal(peer.endLine, 1);
  assert.equal(peer.editing, false);
  assert.equal(peer.cursor, undefined);
  assert.deepEqual(peer.openPaths, ['main.c']);
  assert.deepEqual(peer.openTools, ['layout']);
  assert.equal((await f.manager.state()).peers.length, 1);
});

test('switching between source and tool tabs clears only the active reading range', async (t) => {
  const f = fixture();
  t.after(() => f.manager.dispose());
  const code = await f.manager.presence(
    f.presence(1, { clientKind: 'web', openTools: ['layout', 'ai'], editing: true }),
    false,
  );
  assert.equal(code.peers[0].path, 'main.c');
  assert.equal(code.peers[0].editing, true);
  const layout = await f.manager.presence(
    f.presence(2, { path: '', openTools: ['layout', 'ai'], activeTool: 'layout', clientKind: 'web' }),
    false,
  );
  assert.deepEqual(layout.peers[0].openPaths, ['main.c']);
  assert.deepEqual(layout.peers[0].openTools, ['layout', 'ai']);
  assert.equal(layout.peers[0].path, '');
  const source = await f.manager.presence(
    f.presence(3, { clientKind: 'web', openTools: ['layout', 'ai'] }),
    false,
  );
  assert.equal(source.peers[0].activeTool, undefined);
  assert.equal(source.peers[0].path, 'main.c');
});

test('closing all tabs or leaving a tool-only window cannot be undone by its late presence', async (t) => {
  const f = fixture();
  t.after(() => f.manager.dispose());
  const tool = f.presence(1, { path: '', openPaths: [], openTools: ['layout'], activeTool: 'layout' });
  await f.manager.presence(tool, false);
  await f.manager.leave({ peerId: 'alice-page', actorToken: credential, sequence: 2 }, false);
  assert.equal((await f.manager.presence(tool, false)).peers.length, 0);
  await f.manager.presence({ ...tool, sequence: 3 }, false);
  assert.equal(
    (await f.manager.presence(f.presence(4, { path: '', openPaths: [], openTools: [] }), false)).peers.length,
    0,
  );
  assert.equal((await f.manager.presence({ ...tool, sequence: 3 }, false)).peers.length, 0);
});

test('deleted background code files do not remove an actively viewed tool tab', async (t) => {
  const f = fixture();
  t.after(() => f.manager.dispose());
  await f.manager.presence(f.presence(1, { path: '', openTools: ['layout'], activeTool: 'layout' }), false);
  f.workspace.files = [];
  const peer = (await f.manager.state()).peers[0];
  assert.equal(peer.activeTool, 'layout');
  assert.deepEqual(peer.openPaths, []);
  assert.deepEqual(peer.openTools, ['layout']);
});

test('tool metadata is bounded to known workspace tabs', () => {
  const f = fixture();
  f.manager.dispose();
  assert.equal(
    collaborationSchemas.presence.safeParse(f.presence(1, { openTools: ['layout', 'ai'] })).success,
    true,
  );
  assert.equal(
    collaborationSchemas.presence.safeParse({ ...f.presence(1), openTools: ['shell-command'] }).success,
    false,
  );
  assert.equal(
    collaborationSchemas.presence.safeParse({ ...f.presence(1), activeTool: 'preferences' }).success,
    false,
  );
});

const owner = (values: Record<string, unknown> = {}) => ({
  isWeb: true,
  showHome: false,
  view: 'code',
  activePath: 'main.c',
  openFiles: ['main.c'],
  openTools: [] as CollaborationToolTab[],
  files: [{ path: 'main.c' }],
  ...values,
});
const empty = new Set<string>();
test('local tab collection publishes all owned tools immediately and preserves source tabs', () => {
  const state = localTabPresence(
    owner({ view: 'layout', openTools: ['ai'] }),
    { path: 'main.c', startLine: 64, endLine: 84 },
    empty,
    empty,
  )!;
  assert.equal(state.path, '');
  assert.equal(state.activeTool, 'layout');
  assert.deepEqual(state.openTools, ['ai', 'layout']);
  assert.deepEqual(state.openPaths, ['main.c']);
  assert.equal(
    localTabPresence(owner({ view: 'ai', openFiles: [], activePath: '' }), undefined, empty, empty)!
      .activeTool,
    'ai',
  );
});

test('native tab collection never broadcasts its editor viewport', () => {
  const state = localTabPresence(
    owner({ isWeb: false, openTools: ['layout'] }),
    { path: 'main.c', startLine: 64, endLine: 84, cursor: { line: 70, column: 8 } },
    empty,
    empty,
  )!;
  assert.equal(state.path, '');
  assert.equal(state.clientKind, 'desktop');
  assert.equal(state.cursor, undefined);
  assert.deepEqual(state.openTools, ['layout']);
});

test('closed tools stay closed during the preceding React render and home retains only tab ownership', () => {
  assert.equal(
    localTabPresence(
      owner({ view: 'layout', openFiles: [], openTools: ['layout'] }),
      undefined,
      empty,
      new Set(['layout']),
    ),
    null,
  );
  const home = localTabPresence(
    owner({ showHome: true, view: 'layout', openTools: ['layout', 'ai'] }),
    undefined,
    empty,
    empty,
  )!;
  assert.equal(home.path, '');
  assert.equal(home.activeTool, undefined);
  assert.deepEqual(home.openTools, ['layout', 'ai']);
  assert.deepEqual(home.openPaths, ['main.c']);
  assert.equal(localTabPresence(owner({ openFiles: [], activePath: '' }), undefined, empty, empty), null);
  const remoteOnly = owner();
  Object.assign(remoteOnly, { remoteTools: ['layout', 'ai'] });
  assert.deepEqual(localTabPresence(remoteOnly, undefined, empty, empty)!.openTools, []);
});

test('many local tabs produce a bounded list with the visible source first', () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ path: `file-${i}.c` }));
  const state = localTabPresence(
    owner({
      files,
      openFiles: files.map((file) => file.path),
      activePath: 'file-299.c',
      openTools: ['layout', 'ai'],
    }),
    undefined,
    empty,
    empty,
  )!;
  assert.equal(state.openPaths.length, 256);
  assert.equal(state.openPaths[0], 'file-299.c');
  assert.deepEqual(state.openTools, ['layout', 'ai']);
});
