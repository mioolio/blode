import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startWebServer } from '../src/core/web';
import { RUNTIME_VIEW_CSP } from '../src/shared/runtime-view';
import type { CoreApi } from '../src/shared/contracts';
import { GeneralExtensions } from '../src/core/general-extensions';
import { createGeneralExtensionRoutes } from '../src/core/general-extensions/routes';
import { createWorkbenchBridge } from '../src/shared/workbench-bridge';

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-extension-view-'));
  const desktopWindows: string[] = [],
    panels: string[] = [];
  const manager = new GeneralExtensions({
    dataRoot: path.join(directory, 'extensions'),
    openView: async (id, view) => {
      desktopWindows.push(`${id}/${view.id}`);
    },
    openPanel: async (id, view) => {
      panels.push(`${id}/${view.id}`);
    },
  });
  const review = await manager.review({ path: path.resolve('extensions/plugins/Personalization') });
  await manager.install({ ticket: review.ticket, fingerprint: review.fingerprint, confirm: true });
  const enable = () =>
    manager.enable({
      id: 'Personalization',
      fingerprint: review.fingerprint,
      confirm: true,
      permanent: false,
    });
  await enable();
  const routes = createGeneralExtensionRoutes(
    manager,
    undefined,
    (id, view) => `blode-extension-ui://view/${id}/${view}`,
  ).routes;
  const calls: string[] = [];
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
        calls.push(method);
        const route = routes[method as keyof typeof routes];
        if (!route) throw Error('rpc.methodNotFound');
        return (route.run as (...args: any[]) => unknown)(...route.args.parse(args));
      },
    },
  });
  const token = (await fs.readFile(server.tokenFile, 'utf8')).trim();
  const rpc = (
    args: unknown[] = [{ id: 'Personalization', view: 'appearance' }],
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
      body: JSON.stringify({ method: 'generalExtensionViewUrl', args }),
    });
  t.after(async () => {
    await server.close();
    await manager.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { manager, routes, server, token, calls, rpc, enable, desktopWindows, panels };
}

test('Web extension windows open in browser tabs even when the host also has native window callbacks', async (t) => {
  const f = await fixture(t);
  const open = (view: string, authenticate = true) =>
    fetch(f.server.endpoint + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticate ? { 'x-blode-token': f.token } : {}) },
      body: JSON.stringify({ method: 'generalExtensionOpenView', args: [{ id: 'Personalization', view }] }),
    });
  assert.equal((await open('appearance', false)).status, 401);
  assert.deepEqual(await (await open('appearance')).json(), {
    destination: 'browser',
    url: `${f.server.endpoint}/#/extension-view/Personalization/appearance`,
  });
  assert.deepEqual(f.desktopWindows, []);
  assert.deepEqual(await (await open('preview')).json(), { destination: 'panel' });
  assert.deepEqual(f.panels, ['Personalization/preview']);
  assert.equal((await open('missing')).status, 400);
  await f.manager.disable({ id: 'Personalization' });
  assert.equal((await open('appearance')).status, 400);
});

test('extension documents use authenticated one-use URLs with an independent CSP and no host token', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.rpc(undefined, false)).status, 401);
  for (const args of [
    [],
    [{ id: '../Personalization', view: 'appearance' }],
    [{ id: 'Personalization', view: 'appearance', extra: true }],
  ])
    assert.equal((await f.rpc(args)).status, 400);
  assert.equal((await f.rpc(undefined, true, { origin: 'https://foreign.example' })).status, 400);
  assert.equal(f.calls.length, 0);
  const response = await f.rpc();
  assert.equal(response.status, 200);
  const url = (await response.json()) as string;
  assert.match(url, /\/extension-ui\/[a-f0-9]{48}$/);
  assert.ok(!url.includes(f.token));
  assert.equal(new URL(url).origin, f.server.endpoint);
  const document = await fetch(url);
  assert.equal(document.status, 200);
  assert.equal(document.headers.get('content-security-policy'), RUNTIME_VIEW_CSP);
  assert.equal(document.headers.get('cache-control'), 'no-store');
  assert.equal(document.headers.get('referrer-policy'), 'no-referrer');
  const html = await document.text();
  assert.match(html, /window\.blodeExtension=Object\.freeze/);
  assert.match(html, /<script type="module"\s*>/);
  assert.match(html, /button\.className/);
  assert.ok(!html.includes(f.token));
  assert.equal(f.calls.length, 2);
  assert.equal((await fetch(url)).status, 404);
  assert.equal(f.calls.length, 2);
});

test('extension tickets recheck enablement, expire, reject hostile origins and cannot select a different view', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.rpc([{ id: 'Personalization', view: 'missing' }])).status, 400);
  const first = (await (await f.rpc()).json()) as string;
  await f.manager.disable({ id: 'Personalization' });
  assert.equal((await fetch(first)).status, 403);
  assert.equal((await fetch(first)).status, 404);
  await f.enable();
  const second = (await (await f.rpc()).json()) as string;
  assert.equal((await fetch(second, { headers: { origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(second)).status, 404);
  const third = (await (await f.rpc()).json()) as string;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 15_001);
  assert.equal((await fetch(third)).status, 404);
});

test('desktop view URLs are validated against enabled declarations and shared bridges expose only explicit requests', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.routes.generalExtensionViewUrl.run({ id: 'Personalization', view: 'appearance' }),
    'blode-extension-ui://view/Personalization/appearance',
  );
  await assert.rejects(
    f.routes.generalExtensionViewUrl.run({ id: 'Personalization', view: 'missing' }),
    /extensionPermission/,
  );
  await f.manager.disable({ id: 'Personalization' });
  await assert.rejects(
    f.routes.generalExtensionViewUrl.run({ id: 'Personalization', view: 'appearance' }),
    /extensionDisabled/,
  );
  const seen: unknown[] = [];
  const bridge = createWorkbenchBridge(
    async (method, args) => {
      seen.push({ method, args });
      return 'scoped-url';
    },
    () => () => {},
  );
  assert.equal(await bridge.generalExtensionViewUrl({ id: 'Fixture', view: 'panel' }), 'scoped-url');
  assert.deepEqual(seen, [{ method: 'generalExtensionViewUrl', args: [{ id: 'Fixture', view: 'panel' }] }]);
});

test('main workbench keeps its script policy while allowing only isolated extension frames', async () => {
  const main = await fs.readFile('index.html', 'utf8');
  assert.match(main, /script-src 'self';/);
  assert.doesNotMatch(main, /script-src[^;]*unsafe-inline/);
  assert.match(main, /frame-src[^;]*blode-extension-ui:/);
  const renderer = await fs.readFile('src/renderer/extensions/GeneralExtensionView.tsx', 'utf8');
  assert.match(renderer, /sandbox="allow-scripts"/);
  assert.match(renderer, /key=\{frameKey\}/);
  assert.match(renderer, /documentUrl\.key === frameKey/);
  assert.doesNotMatch(renderer, /srcDoc=|allow-same-origin/);
});
