import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttentionRegistry,
  observePageAttention,
  type NativeAttention,
} from '../src/renderer/workspace/attention';
import { CollaborationResume, retainLocalDocuments } from '../src/renderer/workspace/collaborationResume';
import { localTabPresence } from '../src/renderer/workspace/localPresence';
import { peersForFile, peersForTool } from '../src/renderer/workspace/peerViews';
import { reconcileDismissedTabs, visibleFilePaths } from '../src/renderer/workspace/remoteTabs';
import { CollaborationService } from '../src/core/collaboration';
import { NativePresenceOwner } from '../src/core/native-presence';
import type {
  CollaborationDocument,
  CollaborationPresenceInput,
  CollaborationSnapshot,
} from '../src/shared/collaboration';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
class PageDocument extends EventTarget {
  visibilityState = 'visible';
  focused = true;
  hasFocus() {
    return this.focused;
  }
}
const event = (target: EventTarget, name: string) => target.dispatchEvent(new Event(name));

test('registered attention sources require visibility, focus, connectivity and a present page', () => {
  const page = new EventTarget(),
    doc = new PageDocument(),
    network = { onLine: true };
  let native!: (value: NativeAttention) => void,
    unsubscribed = false;
  const attention = observePageAttention(page, doc, network, (listener) => {
    native = listener;
    return () => {
      unsubscribed = true;
    };
  });
  const samples: boolean[] = [];
  attention.subscribe((value) => samples.push(value.active));
  assert.equal(attention.snapshot().active, false, 'native windows wait for their private initial state');
  native({ visible: true, focused: true, epoch: 0 });
  assert.equal(attention.snapshot().active, true);
  event(page, 'blur');
  assert.equal(attention.snapshot().active, false);
  doc.visibilityState = 'hidden';
  event(doc, 'visibilitychange');
  event(page, 'focus');
  assert.equal(attention.snapshot().active, false);
  doc.visibilityState = 'visible';
  doc.focused = false;
  event(doc, 'visibilitychange');
  assert.equal(attention.snapshot().active, false);
  doc.focused = true;
  event(page, 'focus');
  assert.equal(attention.snapshot().active, true);
  network.onLine = false;
  event(page, 'offline');
  event(page, 'focus');
  assert.equal(attention.snapshot().active, false);
  network.onLine = true;
  event(page, 'online');
  assert.equal(attention.snapshot().active, true);
  event(page, 'pagehide');
  event(page, 'focus');
  assert.equal(attention.snapshot().active, false);
  event(page, 'pageshow');
  assert.equal(attention.snapshot().active, true);
  native({ visible: false, focused: false, epoch: 1 });
  assert.equal(attention.snapshot().active, false);
  native({ visible: true, focused: true, epoch: 2 });
  assert.equal(attention.snapshot().active, true);
  native({ visible: false, focused: false, epoch: 1 });
  assert.equal(attention.snapshot().active, true, 'a delayed blur cannot hide a restored window');
  const count = samples.length;
  const transport = attention.registerSource('transport', true);
  transport.update(false);
  event(page, 'focus');
  assert.equal(attention.snapshot().active, false);
  transport.update(true);
  assert.equal(attention.snapshot().active, true);
  const finalCount = samples.length;
  attention.close();
  event(page, 'blur');
  native({ visible: false, focused: false, epoch: 3 });
  assert.ok(finalCount >= count);
  assert.equal(samples.length, finalCount);
  assert.equal(unsubscribed, true);
});

test('attention source registration is extensible and disposal cannot notify a closed registry', () => {
  const registry = new AttentionRegistry();
  const values: boolean[] = [];
  registry.subscribe((value) => values.push(value.active));
  const first = registry.register('window', true),
    second = registry.register('future-device-attention', false);
  assert.equal(registry.snapshot().active, false);
  second.update(true);
  assert.equal(registry.snapshot().active, true);
  first.update(false);
  second.dispose();
  assert.equal(registry.snapshot().active, false);
  registry.close();
  const count = values.length;
  first.dispose();
  first.update(true);
  assert.equal(values.length, count);
});

function fixture() {
  let now = 1000;
  const service = new CollaborationService({
    workspace: async () => ({
      projectRoot: '/attention',
      files: [
        { path: 'main.c', content: 'a\nb\n' },
        { path: 'next.c', content: 'int next;' },
      ],
    }),
    publish: () => {},
    now: () => now,
  });
  const presence = (
    sequence: number,
    extra: Partial<CollaborationPresenceInput> = {},
  ): CollaborationPresenceInput => ({
    projectRoot: '/attention',
    sequence,
    actorToken: 'a'.repeat(64),
    identity: { peerId: 'one-window', userId: 'one-user', name: 'Alice' },
    path: 'main.c',
    startLine: 64,
    endLine: 84,
    cursor: { line: 70, column: 2 },
    editing: true,
    openPaths: ['main.c', 'next.c'],
    openTools: ['layout'],
    clientKind: 'web',
    attention: 'active',
    ...extra,
  });
  return {
    service,
    presence,
    advance: (value: number) => {
      now += value;
    },
  };
}

test('inactive peers retain tab ownership without any reading badges, editor ranges or obsolete resurrection', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  await f.service.presence(f.presence(1), false);
  const inactive = await f.service.presence(
    f.presence(2, {
      attention: 'inactive',
      path: '',
      editing: false,
      openPaths: undefined,
      openTools: undefined,
    }),
    false,
  );
  const peer = inactive.peers[0];
  assert.equal(peer.attention, 'inactive');
  assert.equal(peer.path, '');
  assert.equal(peer.cursor, undefined);
  assert.equal(peer.editing, false);
  assert.equal(peer.activeTool, undefined);
  assert.deepEqual(peer.openPaths, ['main.c', 'next.c']);
  assert.deepEqual(peer.openTools, ['layout']);
  assert.deepEqual(peersForFile(inactive.peers, 'main.c'), []);
  assert.deepEqual(peersForTool(inactive.peers, 'layout'), []);
  const dismissed = reconcileDismissedTabs(new Set(['main.c']), [], peer.openPaths!);
  assert.deepEqual(visibleFilePaths([], peer.openPaths!, dismissed), ['next.c']);
  assert.equal((await f.service.presence(f.presence(1), false)).peers[0].attention, 'inactive');
  f.advance(60_000);
  assert.equal(
    (await f.service.state()).peers.length,
    1,
    'background timer throttling does not reopen dismissed remote suggestions',
  );
  const resumed = await f.service.presence(
    f.presence(3, { path: 'next.c', startLine: 2, endLine: 3, openPaths: ['next.c'], openTools: [] }),
    false,
  );
  assert.equal(resumed.peers[0].path, 'next.c');
  assert.deepEqual(resumed.peers[0].openPaths, ['next.c']);
  await f.service.presence(f.presence(2, { attention: 'inactive' }), false);
  assert.equal((await f.service.state()).peers[0].attention, 'active');
  await f.service.leave({ peerId: 'one-window', actorToken: 'a'.repeat(64), sequence: 4 }, false);
  assert.equal((await f.service.presence(f.presence(3), false)).peers.length, 0);
});

test('native attention gates queued old IPC after restore and does not affect another window of the same user', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const owner = new NativePresenceOwner(f.service);
  await f.service.presence(
    f.presence(1, {
      identity: { peerId: 'browser-window', userId: 'one-user', name: 'Alice' },
      actorToken: 'b'.repeat(64),
    }),
    false,
  );
  await owner.presence(f.presence(1, { clientKind: 'desktop' }));
  const inactiveEpoch = await owner.setAttention(false);
  assert.equal(inactiveEpoch, 1);
  assert.equal(
    (await f.service.state()).peers.find((peer) => peer.peerId === 'one-window')?.attention,
    'inactive',
  );
  assert.equal(
    (await f.service.state()).peers.find((peer) => peer.peerId === 'browser-window')?.attention,
    'active',
  );
  const epoch = await owner.setAttention(true);
  assert.equal(epoch, 2);
  await owner.presence(f.presence(2, { attentionEpoch: 0, clientKind: 'desktop' }));
  assert.deepEqual(
    (await f.service.state()).peers.find((peer) => peer.peerId === 'one-window')?.openPaths,
    ['main.c', 'next.c'],
    'late pre-blur metadata retains existing tab ownership without reactivating it',
  );
  assert.equal(
    (await f.service.state()).peers.find((peer) => peer.peerId === 'one-window')?.attention,
    'inactive',
  );
  await owner.presence(
    f.presence(3, {
      attentionEpoch: epoch,
      clientKind: 'desktop',
      openTools: ['layout'],
      activeTool: 'layout',
    }),
  );
  assert.equal(
    (await f.service.state()).peers.find((peer) => peer.peerId === 'one-window')?.activeTool,
    'layout',
  );
  await owner.presence(f.presence(2, { attentionEpoch: 0, clientKind: 'desktop' }));
  assert.equal(
    (await f.service.state()).peers.find((peer) => peer.peerId === 'one-window')?.attention,
    'active',
  );
});

test('an old native response after blur and restore cannot revoke its newer attentive lease', async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const accepted = deferred<void>(),
    release = deferred<void>();
  const owner = new NativePresenceOwner({
    presence: async (input, local) => {
      const result = await f.service.presence(input, local);
      if (input.sequence === 1) {
        accepted.resolve();
        await release.promise;
      }
      return result;
    },
    leave: (input, local) => f.service.leave(input, local),
    setAttention: (ids) => f.service.setAttention(ids),
  });
  const pending = owner.presence(f.presence(1));
  await accepted.promise;
  await owner.setAttention(false);
  const epoch = await owner.setAttention(true);
  await owner.presence(f.presence(3, { attentionEpoch: epoch, path: 'next.c' }));
  release.resolve();
  await pending;
  assert.equal((await f.service.state()).peers[0].attention, 'active');
  assert.equal((await f.service.state()).peers[0].path, 'next.c');
});

const snapshot: CollaborationSnapshot = {
  projectRoot: '/attention',
  session: 'new-session',
  peers: [],
  documents: [{ path: 'main.c', revision: 4, dirty: true }],
};
const document: CollaborationDocument = {
  projectRoot: '/attention',
  session: 'new-session',
  path: 'main.c',
  revision: 4,
  content: 'a\nB\n',
  dirty: true,
};

test('restore epochs discard hidden and superseded work, and do not apply a response to a closed tab', async () => {
  const coordinator = new CollaborationResume();
  const state = deferred<CollaborationSnapshot>(),
    text = deferred<CollaborationDocument>();
  let active = true,
    published = 0,
    adopted = 0;
  const owned = new Set(['main.c']);
  const options = {
    active: () => active,
    snapshot: () => state.promise,
    adoptSnapshot: () => true,
    documents: () => ['main.c'],
    owns: (path: string) => owned.has(path),
    open: () => text.promise,
    adoptDocument: () => {
      adopted++;
    },
    publish: () => {
      published++;
    },
    failed: () => assert.fail('unexpected recovery error'),
  };
  const old = coordinator.run(options);
  active = false;
  coordinator.invalidate();
  state.resolve(snapshot);
  await old;
  assert.equal(published, 0);
  assert.equal(adopted, 0);
  active = true;
  const fresh = coordinator.run({ ...options, snapshot: async () => snapshot });
  await Promise.resolve();
  await Promise.resolve();
  owned.delete('main.c');
  text.resolve(document);
  await fresh;
  assert.equal(adopted, 0);
  assert.equal(published, 1, 'renewal uses the current empty tab set, not the formerly open path');
  const obsoleteState = deferred<CollaborationSnapshot>();
  const obsolete = coordinator.run({ ...options, snapshot: () => obsoleteState.promise });
  await coordinator.run({ ...options, snapshot: async () => snapshot });
  obsoleteState.resolve(snapshot);
  await obsolete;
  assert.equal(published, 2);
});

test('host restart retains private text and its shared baseline without retrying former-session requests', () => {
  const records = new Map([
    [
      'main.c',
      {
        baseline: 'disk',
        local: 'private unsaved edits',
        document,
        request: { id: 'old-request' },
        sending: Promise.resolve(),
      },
    ],
  ]);
  const next = retainLocalDocuments(records);
  assert.equal(next.get('main.c')?.local, 'private unsaved edits');
  assert.equal(next.get('main.c')?.baseline, document.content);
  assert.equal('request' in next.get('main.c')!, false);
  assert.equal('document' in next.get('main.c')!, false);
  assert.equal(records.get('main.c')?.request.id, 'old-request');
});

test('a resumed viewport follows the actual active tab instead of a former cached editor', () => {
  const result = localTabPresence(
    {
      isWeb: true,
      showHome: false,
      view: 'code',
      activePath: 'next.c',
      openFiles: ['main.c', 'next.c'],
      openTools: [],
      files: [{ path: 'main.c' }, { path: 'next.c' }],
    },
    { path: 'main.c', startLine: 64, endLine: 84 },
    new Set(),
    new Set(),
  );
  assert.equal(result?.path, 'next.c');
  assert.equal(result?.startLine, 1);
  const secondary = localTabPresence(
    {
      isWeb: true,
      showHome: false,
      view: 'code',
      activePath: 'main.c',
      openFiles: ['main.c', 'next.c'],
      openTools: [],
      files: [{ path: 'main.c' }, { path: 'next.c' }],
    },
    { path: 'next.c', ownerPath: 'main.c', startLine: 10, endLine: 20 },
    new Set(),
    new Set(),
  );
  assert.equal(secondary?.path, 'next.c', 'a genuinely focused split editor keeps its viewport');
  assert.equal(
    'ownerPath' in secondary!,
    false,
    'local editor context never escapes into strict presence payloads',
  );
});
