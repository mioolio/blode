import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { startWebServer } from '../src/core/web';
import { renderRuntimeView, RUNTIME_VIEW_CSP } from '../src/shared/runtime-view';
import type { CoreApi } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-runtime-view-'));
  await fs.mkdir(path.join(directory, 'dist', 'renderer'), { recursive: true });
  await fs.writeFile(path.join(directory, 'dist', 'renderer', 'index.html'), '<main>Strict workbench</main>');
  const source = {
    approved: true,
    html: '<button id="device">Device</button><script>window.pluginRan = true;</script>' as string | null,
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const server = await startWebServer({
    api: {} as CoreApi,
    dataRoot: directory,
    appRoot: directory,
    isPackaged: true,
    allowExternal: false,
    requireToken: true,
    port: 0,
    hostServices: {
      invoke: async (method, args) => {
        calls.push({ method, args });
        if (method !== 'runtimePluginView') throw Error('unexpected delegated method');
        if (!source.approved) throw Error('error.runtimePluginTrustRequired');
        return source.html;
      },
    },
  });
  const token = (await fs.readFile(server.tokenFile, 'utf8')).trim();
  const rpc = (
    args: unknown[] = ['Fixture', 'device'],
    authenticate = true,
    headers: Record<string, string> = {},
  ) =>
    fetch(server.endpoint + '/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticate ? { 'x-blode-token': token } : {}),
        ...headers,
      },
      body: JSON.stringify({ method: 'runtimePluginViewDocument', args }),
    });
  t.after(async () => {
    await server.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('blode-runtime-view-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { server, source, calls, token, rpc };
}

test('plugin documents are minted only by authenticated, validated RPC and consumed once without a host token', async (t) => {
  const context = await fixture(t);
  assert.equal((await context.rpc(undefined, false)).status, 401);
  assert.equal((await context.rpc(['Fixture', 'other'])).status, 400);
  assert.equal((await context.rpc(['../Fixture', 'device'])).status, 400);
  assert.equal(
    (await context.rpc(['Fixture', 'device'], true, { origin: 'https://foreign.example' })).status,
    400,
  );
  assert.equal(context.calls.length, 0);
  const minted = await context.rpc();
  assert.equal(minted.status, 200);
  const location = (await minted.json()) as string;
  assert.equal(new URL(location).origin, context.server.endpoint);
  assert.match(new URL(location).pathname, /^\/runtime-ui\/[a-f0-9]{48}$/);
  assert.ok(!location.includes(context.token));
  assert.equal(new URL(location).search, '');
  assert.deepEqual(context.calls, [{ method: 'runtimePluginView', args: ['Fixture', 'device'] }]);
  const document = await fetch(location);
  assert.equal(document.status, 200);
  assert.equal(document.headers.get('content-security-policy'), RUNTIME_VIEW_CSP);
  assert.equal(document.headers.get('cache-control'), 'no-store');
  assert.equal(document.headers.get('referrer-policy'), 'no-referrer');
  const content = await document.text();
  assert.match(content, /window\.blodeRuntime=Object\.freeze/);
  assert.match(content, /window\.pluginRan = true/);
  assert.ok(!content.includes(context.token));
  assert.equal(context.calls.length, 2, 'GET rechecks the package authorization');
  assert.equal((await fetch(location)).status, 404);
  assert.equal(context.calls.length, 2, 'replay cannot read the package again');
});

test('revoked authorization and expired tickets cannot deliver plugin scripts', async (t) => {
  const context = await fixture(t);
  const first = (await (await context.rpc()).json()) as string;
  context.source.approved = false;
  const revoked = await fetch(first);
  assert.equal(revoked.status, 403);
  assert.doesNotMatch(await revoked.text(), /pluginRan/);
  assert.equal((await fetch(first)).status, 404);
  assert.equal((await context.rpc()).status, 400);
  context.source.approved = true;
  const second = (await (await context.rpc()).json()) as string;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 15_001);
  assert.equal((await fetch(second)).status, 404);
});

test('view ticket storage is bounded, unavailable views allocate nothing, and one consumed ticket frees capacity', async (t) => {
  const context = await fixture(t);
  context.source.html = null;
  assert.equal(await (await context.rpc()).json(), null);
  context.source.html = '<main>view</main>';
  const locations: string[] = [];
  for (let index = 0; index < 64; index++) {
    const response = await context.rpc();
    assert.equal(response.status, 200);
    locations.push((await response.json()) as string);
  }
  const overflow = await context.rpc();
  assert.equal(overflow.status, 400);
  assert.deepEqual(await overflow.json(), { error: 'rpc.limitExceeded' });
  assert.equal((await fetch(locations[0])).status, 200);
  assert.equal((await context.rpc()).status, 200);
  assert.equal((await fetch(context.server.endpoint + '/runtime-ui/not-a-ticket')).status, 404);
  assert.equal((await fetch(locations[1], { method: 'POST' })).status, 405);
  assert.equal((await fetch(locations[1])).status, 200, 'unsupported methods do not consume the ticket');
});

test('the standalone document bridge executes with inline CSP and accepts replies only from its parent', async () => {
  assert.match(RUNTIME_VIEW_CSP, /script-src 'unsafe-inline'/);
  assert.match(RUNTIME_VIEW_CSP, /connect-src 'none'/);
  assert.match(RUNTIME_VIEW_CSP, /frame-src 'none'/);
  const html = renderRuntimeView('<main>custom view</main>');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const listeners: ((event: any) => void)[] = [];
  const requests: any[] = [];
  const parent = { postMessage: (value: any) => requests.push(value) };
  const window: any = {
    addEventListener: (kind: string, listener: (event: any) => void) => {
      assert.equal(kind, 'message');
      listeners.push(listener);
    },
  };
  vm.runInNewContext(script, { window, parent, Map, Promise, Error, setTimeout, clearTimeout });
  assert.equal(Object.isFrozen(window.blodeRuntime), true);
  const pending = window.blodeRuntime.context();
  assert.equal(requests[0].method, 'context.get');
  listeners[0]({ source: {}, data: { channel: 'blode-runtime-ui', id: requests[0].id, result: 'forged' } });
  listeners[0]({
    source: parent,
    data: { channel: 'blode-runtime-ui', id: requests[0].id, result: { deviceId: 'USB1' } },
  });
  assert.deepEqual(await pending, { deviceId: 'USB1' });
  assert.equal(window.blode, undefined);
});
