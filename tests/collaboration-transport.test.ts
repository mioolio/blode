import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CollaborationService } from '../src/core/collaboration';
import { createAssistanceRoutes } from '../src/core/assistance-routes';
import { AiAssistance } from '../src/core/ai-assistance';
import { UiCommands } from '../src/core/ui-commands';
import { startWebServer } from '../src/core/web';
import type { CoreApi } from '../src/shared/contracts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t: TestContext, delayPresence?: (sequence: number) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-presence-transport-'));
  const workspace = {
    projectRoot: '/transport-fixture',
    files: [{ path: 'main.c', content: 'int main(void) {}\n' }],
  };
  const collaboration = new CollaborationService({ workspace: async () => workspace, publish: () => {} });
  const ui = new UiCommands(() => {}),
    ai = new AiAssistance({ dataRoot: root, projectRoot: () => workspace.projectRoot });
  const routes = createAssistanceRoutes(ai, collaboration, ui, false);
  const server = await startWebServer({
    api: { getState: async () => ({}) } as unknown as CoreApi,
    assistance: {
      invoke: async (method, args) => {
        if (method === 'collaborationPresence') await delayPresence?.((args[0] as any).sequence);
        return routes.invoke(method, args);
      },
    },
    dataRoot: root,
    appRoot: root,
    isPackaged: true,
    allowExternal: false,
    port: 0,
  });
  const controllers: AbortController[] = [];
  t.after(async () => {
    controllers.forEach((controller) => controller.abort());
    await server.close();
    collaboration.dispose();
    ui.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const rpc = async (method: string, args: unknown[], client?: string) => {
    const result = await fetch(server.endpoint + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(client ? { 'x-blode-client': client } : {}) },
      body: JSON.stringify({ method, args }),
    });
    const value = await result.json();
    assert.equal(result.status, 200, JSON.stringify(value));
    return value;
  };
  const session = (await rpc('collaborationState', [])).session;
  const presence = (name: string, sequence: number, client: string) =>
    rpc(
      'collaborationPresence',
      [
        {
          projectRoot: workspace.projectRoot,
          session,
          sequence,
          identity: { peerId: name, userId: name, name },
          actorToken: (name === 'alice' ? 'a' : 'b').repeat(64),
          path: 'main.c',
          startLine: 1,
          endLine: 1,
          editing: false,
          openPaths: ['main.c'],
        },
      ],
      client,
    );
  const stream = async (client: string) => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(server.endpoint + '/events?client=' + client, { signal: controller.signal });
    assert.equal(response.status, 200);
    return controller;
  };
  const peers = async () =>
    ((await rpc('collaborationState', [])).peers as { peerId: string }[]).map((peer) => peer.peerId).sort();
  const expectPeers = async (expected: string[]) => {
    for (let index = 0; index < 80; index++) {
      const actual = await peers();
      if (JSON.stringify(actual) === JSON.stringify(expected)) return;
      await pause(25);
    }
    assert.deepEqual(await peers(), expected);
  };
  return { rpc, presence, stream, peers, expectPeers };
}

test('closing a browser stream releases only that page without waiting for the offline TTL', async (t) => {
  const f = await fixture(t),
    alice = 'a'.repeat(32),
    bob = 'b'.repeat(32);
  const a = await f.stream(alice);
  await f.stream(bob);
  await f.presence('alice', 1, alice);
  await f.presence('bob', 1, bob);
  assert.deepEqual(await f.peers(), ['alice', 'bob']);
  a.abort();
  await f.expectPeers(['bob']);
  const document = await f.rpc('collaborationOpen', ['/transport-fixture', 'main.c']);
  assert.equal(document.content, 'int main(void) {}\n');
});

test('a replacement event stream protects the live page from an older socket close', async (t) => {
  const f = await fixture(t),
    client = 'c'.repeat(32);
  const original = await f.stream(client);
  await f.presence('alice', 1, client);
  original.abort();
  await pause(40);
  const replacement = await f.stream(client);
  await f.presence('alice', 2, client);
  await pause(260);
  assert.deepEqual(await f.peers(), ['alice']);
  replacement.abort();
  await f.expectPeers([]);
});

test('a presence request finishing after disconnect cannot resurrect its closed browser page', async (t) => {
  let finish: (() => void) | undefined, entered: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const f = await fixture(t, async (sequence) => {
      if (sequence === 2) {
        entered?.();
        await waiting;
      }
    }),
    client = 'd'.repeat(32);
  const stream = await f.stream(client);
  await f.presence('alice', 1, client);
  const pending = f.presence('alice', 2, client);
  await started;
  stream.abort();
  await f.expectPeers([]);
  finish?.();
  await pending;
  await f.expectPeers([]);
});

test('a browser initiating global close without a local tab still owns a revocable transaction lease', async (t) => {
  const f = await fixture(t),
    alice = 'a'.repeat(32),
    observer = 'c'.repeat(32);
  await f.stream(alice);
  const socket = await f.stream(observer);
  await f.presence('alice', 1, alice);
  const session = (await f.rpc('collaborationState', [])).session;
  const pending = await f.rpc(
    'collaborationTabClose',
    [
      {
        projectRoot: '/transport-fixture',
        session,
        peerId: 'observer',
        actorToken: 'c'.repeat(64),
        requestId: 'observer-close',
        target: { kind: 'file', id: 'main.c' },
      },
    ],
    observer,
  );
  assert.equal(pending.tabCloses[0].status, 'preparing');
  socket.abort();
  for (let index = 0; index < 80; index++) {
    const current = await f.rpc('collaborationState', []);
    if (current.tabCloses[0].status === 'aborted') return;
    await pause(25);
  }
  assert.fail('closing the initiating page must abort the unsaved-file transaction');
});
