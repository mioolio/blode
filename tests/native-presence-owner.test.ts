import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationService } from '../src/core/collaboration';
import { NativePresenceOwner } from '../src/core/native-presence';
import type { CollaborationPresenceInput, CollaborationSnapshot } from '../src/shared/collaboration';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let now = 0;
  const workspace = {
    projectRoot: '/native-fixture',
    files: [{ path: 'main.c', content: 'int main(void) {}\n' }],
  };
  const service = new CollaborationService({
    workspace: async () => structuredClone(workspace),
    publish: () => {},
    now: () => now,
  });
  const native = (sequence: number): CollaborationPresenceInput => ({
    projectRoot: workspace.projectRoot,
    sequence,
    identity: { peerId: 'native', userId: 'local-user', name: 'Local' },
    path: '',
    startLine: 1,
    endLine: 1,
    editing: false,
    openPaths: [],
    openTools: ['layout'],
    activeTool: 'layout',
    clientKind: 'desktop',
  });
  const browser = (sequence: number): CollaborationPresenceInput => ({
    projectRoot: workspace.projectRoot,
    sequence,
    identity: { peerId: 'browser', userId: 'remote-user', name: 'Remote' },
    actorToken: 'b'.repeat(64),
    path: 'main.c',
    startLine: 3,
    endLine: 7,
    editing: false,
    openPaths: ['main.c'],
    clientKind: 'web',
  });
  return {
    service,
    native,
    browser,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a desktop layout-only lease survives state reads and clear removes only its real window', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const owner = new NativePresenceOwner(f.service);
  await f.service.presence(f.browser(1), false);
  await owner.presence(f.native(1));
  f.advance(15_000);
  const current = await f.service.state();
  assert.equal(current.peers.length, 2);
  const local = current.peers.find((peer) => peer.peerId === 'native')!;
  assert.equal(local.path, '');
  assert.deepEqual(local.openTools, ['layout']);
  assert.equal(local.activeTool, 'layout');
  assert.equal(local.editing, false);
  assert.equal(local.cursor, undefined);
  await owner.clear();
  assert.deepEqual(
    (await f.service.state()).peers.map((peer) => peer.peerId),
    ['browser'],
  );
});

test('clear while a native presence response is pending cannot resurrect the closed renderer', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const accepted = deferred(),
    release = deferred();
  const owner = new NativePresenceOwner({
    presence: async (input, trusted) => {
      const result = await f.service.presence(input, trusted);
      accepted.resolve();
      await release.promise;
      return result;
    },
    leave: (input, trusted) => f.service.leave(input, trusted),
  });
  await f.service.presence(f.browser(1), false);
  const pending = owner.presence(f.native(1));
  await accepted.promise;
  await owner.clear();
  release.resolve();
  await pending;
  assert.deepEqual(
    (await f.service.state()).peers.map((peer) => peer.peerId),
    ['browser'],
  );
});

test('an obsolete native leave does not release its replacement lease or erase ownership tracking', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const owner = new NativePresenceOwner(f.service);
  const first = await owner.presence(f.native(1));
  await owner.presence({ ...f.native(2), openTools: ['layout', 'ai'], activeTool: 'ai' });
  await owner.leave({
    peerId: 'native',
    projectRoot: first.projectRoot,
    session: first.session,
    sequence: 1,
  });
  assert.equal((await f.service.state()).peers[0].activeTool, 'ai');
  await owner.clear();
  assert.equal((await f.service.state()).peers.length, 0);
});

test('a delayed old renderer response cannot remove a newer lease created after reload', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const accepted = deferred(),
    release = deferred();
  const owner = new NativePresenceOwner({
    presence: async (input, trusted): Promise<CollaborationSnapshot> => {
      const result = await f.service.presence(input, trusted);
      if (input.sequence === 1) {
        accepted.resolve();
        await release.promise;
      }
      return result;
    },
    leave: (input, trusted) => f.service.leave(input, trusted),
  });
  const old = owner.presence(f.native(1));
  await accepted.promise;
  await owner.clear();
  await owner.presence({
    ...f.native(3),
    attentionEpoch: await owner.setAttention(true),
    openTools: ['ai'],
    activeTool: 'ai',
  });
  release.resolve();
  await old;
  const peers = (await f.service.state()).peers;
  assert.equal(peers.length, 1);
  assert.equal(peers[0].activeTool, 'ai');
  await owner.clear();
  assert.equal((await f.service.state()).peers.length, 0);
});

test('navigation rejects a queued former-renderer presence before fresh handshake restores its own tabs', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const owner = new NativePresenceOwner(f.service);
  await owner.presence(f.native(1));
  await owner.clear();
  await owner.presence(f.native(2));
  assert.equal(
    (await f.service.state()).peers.length,
    0,
    'an IPC queued by the former renderer owns no tabs',
  );
  const epoch = await owner.setAttention(true);
  await owner.presence({ ...f.native(3), attentionEpoch: epoch });
  assert.deepEqual((await f.service.state()).peers[0].openTools, ['layout']);
});
