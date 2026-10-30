import assert from 'node:assert/strict';
import test from 'node:test';
import { CollaborationService } from '../src/core/collaboration';
import { SharedSurfaceOutbox, SharedWorkspaceClient } from '../src/renderer/workspace/sharedTabs';
import { registeredWorkspaceSurface } from '../src/shared/workspace-surfaces';
import type {
  CollaborationSnapshot,
  WorkspaceTabCloseRequest,
  WorkspaceTabCloseVote,
} from '../src/shared/collaboration';

const path = 'main.c',
  root = '/shared-tabs';
async function fixture() {
  const workspace = {
    projectRoot: root,
    files: [
      { path, content: 'int saved;\n' },
      { path: 'other.c', content: 'int other;' },
    ],
  };
  let now = 1_000_000;
  const listeners = new Set<(snapshot: CollaborationSnapshot) => void>();
  const service = new CollaborationService({
    workspace: async () => structuredClone(workspace),
    freshWorkspace: async () => structuredClone(workspace),
    now: () => now,
    saveFile: async (path, content) => {
      workspace.files.find((file) => file.path === path)!.content = content;
    },
    publish: (event) => {
      if (event.type === 'presence' || event.type === 'workspace')
        for (const listener of listeners) queueMicrotask(() => listener(event.snapshot));
    },
  });
  const session = (await service.state()).session;
  const context = (peerId: string) => ({
    projectRoot: root,
    session,
    peerId,
    actorToken: peerId[0].repeat(64),
  });
  const presence = (peerId: string, sequence: number, tabRevision = 0, values: object = {}) =>
    service.presence(
      {
        projectRoot: root,
        session,
        actorToken: context(peerId).actorToken,
        identity: { peerId, userId: peerId, name: peerId },
        sequence,
        tabRevision,
        path,
        startLine: 1,
        endLine: 1,
        editing: false,
        openPaths: [path, 'other.c'],
        ...values,
      },
      false,
    );
  const close = (peerId = 'alice', requestId = 'close-1', target = { kind: 'file' as const, id: path }) =>
    service.tabClose({ ...context(peerId), requestId, target }, false);
  const vote = (peerId: string, decision: 'ready' | 'cancel', requestId = 'close-1', documentRevision = 0) =>
    service.tabCloseVote(
      {
        ...context(peerId),
        requestId,
        decision,
        documentRevision,
      },
      false,
    );
  await presence('alice', 1);
  await presence('bob', 1);
  return {
    service,
    workspace,
    session,
    context,
    presence,
    close,
    vote,
    listeners,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a close waits for all owners; cancellation leaves every tab and shared draft intact', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  let doc = await f.service.open(root, path);
  await f.service.edit(
    {
      ...f.context('alice'),
      path,
      requestId: 'edit',
      baseRevision: doc.revision,
      changes: [{ start: 0, end: 0, text: '// unsaved\n' }],
    },
    false,
  );
  const close = await f.close();
  assert.deepEqual(close.tabCloses![0].participants, ['alice', 'bob']);
  assert.equal((await f.vote('alice', 'ready', 'close-1', 1)).tabCloses![0].status, 'preparing');
  const cancelled = await f.vote('bob', 'cancel', 'close-1', 1);
  assert.equal(cancelled.tabCloses![0].status, 'aborted');
  assert.equal(cancelled.tabRevision, 0);
  assert.ok(cancelled.peers.every((peer) => peer.openPaths!.includes(path)));
  assert.equal((await f.service.open(root, path)).content, '// unsaved\nint saved;\n');
});

test('a home-page owner remains in global close consensus while no longer advertising a reading range', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  const state = await f.presence('bob', 2, 0, {
    attention: 'inactive',
    path: '',
    startLine: 1,
    endLine: 1,
    openTools: ['layout'],
  });
  const home = state.peers.find((peer) => peer.peerId === 'bob')!;
  assert.equal(home.attention, 'inactive');
  assert.equal(home.path, '');
  assert.ok(home.openPaths!.includes(path));
  await f.service.open(root, path);
  const pending = await f.close();
  assert.ok(pending.tabCloses![0].participants.includes('bob'));
  await f.vote('alice', 'ready');
  const aborted = await f.vote('bob', 'cancel');
  assert.equal(aborted.tabCloses![0].status, 'aborted');
  assert.ok(aborted.peers.every((peer) => peer.openPaths!.includes(path)));
});

test('all-owner discard evicts confirmed draft, rejects stale opens, and reopens saved disk text', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  await f.service.open(root, path);
  await f.service.edit(
    {
      ...f.context('alice'),
      path,
      requestId: 'edit',
      baseRevision: 0,
      changes: [{ start: 0, end: 0, text: '// dropped\n' }],
    },
    false,
  );
  await f.close();
  await f.vote('alice', 'ready', 'close-1', 1);
  const done = await f.vote('bob', 'ready', 'close-1', 1);
  assert.equal(done.tabCloses![0].status, 'committed');
  assert.equal(done.tabRevision, 1);
  assert.ok(done.peers.every((peer) => !peer.openPaths!.includes(path)));
  assert.equal(
    done.documents.find((doc) => doc.path === path),
    undefined,
  );
  const late = await f.presence('alice', 2, 0);
  assert.deepEqual(late.peers.find((peer) => peer.peerId === 'alice')!.openPaths, ['other.c']);
  const reopened = await f.service.open(root, path);
  assert.equal(reopened.content, 'int saved;\n');
  assert.equal(reopened.revision, 2);
  await f.presence('alice', 3, 1);
  // A retried successful vote must not evict/reclose a deliberately reopened file.
  await f.vote('alice', 'ready', 'close-1', 1);
  assert.ok(
    (await f.service.state()).peers.find((peer) => peer.peerId === 'alice')!.openPaths!.includes(path),
  );
  assert.equal((await f.service.open(root, path)).revision, reopened.revision);
});

test('save then global close retains saved text; a changed ready version aborts', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  await f.service.open(root, path);
  const edited = await f.service.edit(
    {
      ...f.context('alice'),
      path,
      requestId: 'edit',
      baseRevision: 0,
      changes: [{ start: 0, end: 0, text: '// saved\n' }],
    },
    false,
  );
  await f.close();
  await f.vote('alice', 'ready', 'close-1', 1);
  await assert.rejects(
    () =>
      f.service.edit(
        {
          ...f.context('alice'),
          path,
          requestId: 'frozen-edit',
          baseRevision: 1,
          changes: [{ start: 0, end: 0, text: 'bad' }],
        },
        false,
      ),
    /tabCloseChanged/,
  );
  await f.service.edit(
    {
      ...f.context('bob'),
      path,
      requestId: 'new-edit',
      baseRevision: 1,
      changes: [{ start: 0, end: 0, text: '// newer\n' }],
    },
    false,
  );
  assert.equal((await f.vote('bob', 'ready', 'close-1', 2)).tabCloses![0].status, 'aborted');
  const current = await f.service.open(root, path);
  await f.service.save({ projectRoot: root, session: f.session, path, revision: current.revision });
  await f.close('alice', 'close-2');
  await f.vote('alice', 'ready', 'close-2', current.revision);
  await f.vote('bob', 'ready', 'close-2', current.revision);
  assert.equal((await f.service.open(root, path)).content, '// newer\n// saved\nint saved;\n');
  assert.equal(edited.status, 'applied');
});

test('owner departure, timeout and late joining owners cannot silently approve close', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  await f.service.open(root, path);
  await f.close();
  await f.vote('alice', 'ready');
  await f.presence('charlie', 1);
  assert.equal((await f.vote('bob', 'ready')).tabCloses![0].status, 'preparing');
  await f.service.leave({ ...f.context('charlie'), sequence: 2 }, false);
  assert.equal((await f.service.state()).tabCloses![0].status, 'aborted');
  await f.close('alice', 'close-2');
  f.advance(120_001);
  assert.equal(
    (await f.service.state()).tabCloses!.find((tx) => tx.requestId === 'close-2')!.status,
    'aborted',
  );
});

test('registered console/plugin surfaces replay in last-selected order and can switch back', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  assert.equal(registeredWorkspaceSurface({ kind: 'console', id: 'plugin:camera/frame' }), true);
  for (const id of ['output', 'serial', 'output', 'plugin:camera/frame'])
    await f.service.surfaceUpdate(
      { ...f.context('alice'), target: { kind: 'console', id }, open: true },
      false,
    );
  const state = await f.service.state();
  assert.deepEqual(
    state.surfaces!.map((item) => item.target.id),
    ['serial', 'output', 'plugin:camera/frame'],
  );
  await assert.rejects(() =>
    f.service.surfaceUpdate(
      { ...f.context('alice'), target: { kind: 'console', id: 'unknown' }, open: true },
      false,
    ),
  );
});

test('atomic surface bootstrap seeds first client preferences without letting late clients replace them', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  await f.service.surfaceBootstrap(
    {
      ...f.context('alice'),
      surfaces: [
        { target: { kind: 'console', id: 'memory' }, open: true },
        { target: { kind: 'panel', id: 'console' }, open: false },
        { target: { kind: 'panel', id: 'device' }, open: false },
        { target: { kind: 'panel', id: 'runtime' }, open: true },
      ],
    },
    false,
  );
  const late = await f.service.surfaceBootstrap(
    {
      ...f.context('bob'),
      surfaces: [
        { target: { kind: 'console', id: 'output' }, open: true },
        { target: { kind: 'panel', id: 'console' }, open: true },
        { target: { kind: 'panel', id: 'device' }, open: true },
        { target: { kind: 'panel', id: 'runtime' }, open: false },
      ],
    },
    false,
  );
  assert.deepEqual(
    late.surfaces!.map(({ target, open }) => [target.kind, target.id, open]),
    [
      ['console', 'memory', true],
      ['panel', 'console', false],
      ['panel', 'device', false],
      ['panel', 'runtime', true],
    ],
  );
  await assert.rejects(() =>
    f.service.surfaceBootstrap(
      { ...f.context('bob'), surfaces: [{ target: { kind: 'tool', id: 'layout' }, open: true }] },
      false,
    ),
  );
});

test('two client coordinators commit together and a cancelling peer aborts both staged closes', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  const clients: SharedWorkspaceClient[] = [],
    closed: string[] = [],
    aborted: string[] = [],
    errors: unknown[] = [];
  const decisions = new Map([
    ['alice', true],
    ['bob', true],
  ]);
  for (const name of ['alice', 'bob']) {
    const versions = new Map<string, number>();
    const client = new SharedWorkspaceClient({
      context: () => f.context(name),
      request: (context, target, requestId) => f.service.tabClose({ ...context, target, requestId }, false),
      vote: (context, requestId, decision) =>
        f.service.tabCloseVote(
          { ...context, requestId, decision, documentRevision: versions.get(requestId) },
          false,
        ),
      prepare: async (target, requestId) => {
        versions.set(requestId, (await f.service.open(root, target.id)).revision);
        return decisions.get(name)!;
      },
      commit: () => {
        closed.push(name);
        return true;
      },
      abort: () => {
        aborted.push(name);
      },
      surface: () => {},
      changed: () => {},
      failure: (error) => errors.push(error),
    });
    clients.push(client);
    f.listeners.add((snapshot) => client.accept(snapshot));
    client.accept(await f.service.state());
  }
  t.after(() => clients.forEach((client) => client.reset()));
  assert.equal(await clients[0].close({ kind: 'file', id: path }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed.sort(), ['alice', 'bob']);
  assert.deepEqual(errors, []);
  await f.presence('alice', 2, 1);
  await f.presence('bob', 2, 1);
  decisions.set('bob', false);
  closed.length = 0;
  assert.equal(await clients[0].close({ kind: 'file', id: path }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, []);
  assert.ok(aborted.includes('alice') && aborted.includes('bob'));
  // The historical abort for this same target must not resolve a fresh close prematurely.
  decisions.set('bob', true);
  assert.equal(await clients[0].close({ kind: 'file', id: path }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed.sort(), ['alice', 'bob']);
});

test('closure replay asks a dirty recovering client; cancellation never discards its local text', async () => {
  const context = { projectRoot: root, session: 'replay', peerId: 'recover', actorToken: 'a'.repeat(64) };
  let prepared = 0,
    committed = 0,
    aborted = 0;
  const client = new SharedWorkspaceClient({
    context: () => context,
    request: async () => {
      throw Error('unused');
    },
    vote: async () => {
      throw Error('unused');
    },
    prepare: async () => {
      prepared++;
      return false;
    },
    commit: () => {
      committed++;
      return true;
    },
    abort: () => {
      aborted++;
    },
    surface: () => {},
    changed: () => {},
    failure: () => {},
  });
  const snapshot: CollaborationSnapshot = {
    projectRoot: root,
    session: 'replay',
    peers: [],
    documents: [],
    tabRevision: 4,
    closedTabs: [{ target: { kind: 'file', id: path }, revision: 4 }],
  };
  client.accept(snapshot);
  client.accept(snapshot);
  assert.equal(client.tabRevision, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, 1);
  assert.equal(committed, 0);
  assert.equal(aborted, 1);
  assert.equal(client.tabRevision, 4);
  client.reset();
});

test('a late client does not stage historical closes for tabs it never owned', async () => {
  const context = {
    projectRoot: root,
    session: 'unowned-replay',
    peerId: 'late',
    actorToken: 'a'.repeat(64),
  };
  const client = new SharedWorkspaceClient({
    context: () => context,
    request: async () => {
      throw Error('unused');
    },
    vote: async () => {
      throw Error('unused');
    },
    owns: () => false,
    prepare: async () => {
      assert.fail('unowned historical close must not occupy local prompt/staging');
    },
    commit: () => {
      assert.fail('unowned historical close must not modify local tabs');
    },
    abort: () => {},
    surface: () => {},
    changed: () => {},
    failure: () => {},
  });
  client.accept({
    projectRoot: root,
    session: context.session,
    peers: [],
    documents: [],
    tabRevision: 2,
    closedTabs: [{ target: { kind: 'file', id: path }, revision: 2 }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.tabRevision, 2);
  client.reset();
});

test('surface outbox coalesces offline intents, retries after transport failure and isolates projects', async () => {
  const queue = new SharedSurfaceOutbox(),
    sent: string[] = [];
  queue.publish({ kind: 'console', id: 'output' }, true);
  queue.publish({ kind: 'panel', id: 'console' }, false);
  queue.publish({ kind: 'panel', id: 'console' }, true);
  await assert.rejects(
    queue.flush(async () => {
      throw Error('offline');
    }),
    /offline/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  let release!: () => void;
  const pending = queue.flush(async (target, open) => {
    sent.push(`${target.kind}:${target.id}:${open}`);
    if (target.kind === 'console')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  queue.publish({ kind: 'panel', id: 'console' }, false);
  release();
  await pending;
  assert.deepEqual(sent, ['console:output:true', 'panel:console:false']);
  queue.publish({ kind: 'panel', id: 'device' }, false);
  queue.reset();
  await queue.flush(async () => {
    assert.fail('old project intents must not leak');
  });
});

test('terminal close does not regress with delayed preparation and explicitly reopened tools stay open', async () => {
  const context = {
    projectRoot: root,
    session: 'tool-replay',
    peerId: 'recover',
    actorToken: 'a'.repeat(64),
  };
  let preparations = 0,
    commits = 0;
  const surfaces: string[] = [];
  const client = new SharedWorkspaceClient({
    context: () => context,
    request: async () => {
      throw Error('unused');
    },
    vote: async () => {
      throw Error('unused');
    },
    prepare: async () => {
      preparations++;
      return true;
    },
    commit: () => {
      commits++;
      return true;
    },
    abort: () => {},
    surface: (target, open) => surfaces.push(`${target.id}:${open}`),
    changed: () => {},
    failure: () => {},
  });
  const tx = {
    requestId: 'old-tool-close',
    target: { kind: 'tool' as const, id: 'layout' },
    status: 'committed' as const,
    revision: 1,
    participants: ['recover'],
    ready: ['recover'],
    expiresAt: '',
  };
  const state: CollaborationSnapshot = {
    projectRoot: root,
    session: context.session,
    peers: [],
    documents: [],
    tabRevision: 2,
    tabCloses: [tx],
    closedTabs: [{ target: tx.target, revision: 1 }],
    surfaces: [{ target: tx.target, open: true, revision: 2 }],
  };
  client.accept(state);
  client.accept({
    ...state,
    presenceRevision: 0,
    tabRevision: 1,
    tabCloses: [{ ...tx, status: 'preparing' }],
    closedTabs: [],
    surfaces: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preparations, 0);
  assert.equal(commits, 0);
  assert.deepEqual(surfaces, ['layout:true']);
  client.reset();
});

test('a new close clicked while cancellation is awaiting its network acknowledgement retries once', async () => {
  for (const initiallyReady of [false, true]) {
    const context = { projectRoot: root, session: 'retry', peerId: 'alice', actorToken: 'a'.repeat(64) };
    let releaseCancel!: () => void,
      enteredCancel!: () => void,
      requests = 0,
      prepared = 0,
      commits = 0;
    const gate = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enteredCancel = resolve;
      });
    const snapshot: CollaborationSnapshot = {
      projectRoot: root,
      session: 'retry',
      peers: [],
      documents: [],
      tabRevision: 0,
      tabCloses: [],
    };
    const client = new SharedWorkspaceClient({
      context: () => context,
      request: async (_, target, requestId) => {
        requests++;
        snapshot.tabCloses!.push({
          requestId,
          target,
          status: 'preparing',
          revision: 0,
          participants: ['alice'],
          ready: [],
          expiresAt: '',
        });
        return structuredClone(snapshot);
      },
      vote: async (_, requestId, decision) => {
        if (requests === 1) {
          enteredCancel();
          await gate;
        }
        const tx = snapshot.tabCloses!.find((tx) => tx.requestId === requestId)!;
        tx.status = requests === 1 || decision === 'cancel' ? 'aborted' : 'committed';
        if (tx.status === 'committed') {
          snapshot.tabRevision = 1;
          tx.revision = 1;
        }
        return structuredClone(snapshot);
      },
      prepare: async () => ++prepared > 1 || initiallyReady,
      commit: () => {
        commits++;
        return true;
      },
      abort: () => {},
      surface: () => {},
      changed: () => {},
      failure: (error) => {
        throw error;
      },
    });
    const initial = client.close({ kind: 'file', id: path });
    await entered;
    const retried = client.close({ kind: 'file', id: path });
    releaseCancel();
    assert.equal(await initial, false);
    assert.equal(await retried, true);
    assert.equal(requests, 2);
    assert.equal(commits, 1);
    client.reset();
  }
});
