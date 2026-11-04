/** Boundary: isolated HTTP/Vite integration tests for the development API proxy.
 * Uses only owned temporary servers and synthetic endpoint metadata; never starts
 * Electron, reads credentials, or invokes the real application API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as requestHttp, type IncomingMessage } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Plugin } from 'vite';
import { developmentHostApi } from '../scripts/dev-host-api';
import { startWebServer } from '../src/core/web';
import type { CoreApi } from '../src/shared/contracts';

type Reply = { status: number; headers: IncomingMessage['headers']; body: Buffer };

/** A bounded wait makes missing stream cancellation fail instead of hanging teardown. */
async function within<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'the development origin privately proxies RPC, resources and live events',
  { timeout: 30_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-dev-host-api-test-'));
    const endpointFile = path.join(root, 'desktop-endpoint.json');
    let markDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      markDisconnected = resolve;
    });
    const observed: { path: string; host?: string; origin?: string; referer?: string; body: string }[] = [];
    let privateAuthority = '';
    const backend = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        observed.push({
          path: request.url ?? '',
          host: request.headers.host,
          origin: request.headers.origin,
          referer: request.headers.referer,
          body,
        });
        // Model the private backend's authority/origin gate: LAN headers must be
        // validated at the public listener and rewritten before reaching it.
        if (request.headers.host !== privateAuthority || request.headers.origin || request.headers.referer) {
          response.writeHead(401);
          response.end('private backend rejected forwarded authority');
          return;
        }
        if (request.url?.startsWith('/events?')) {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          response.flushHeaders();
          response.write('event: ready\ndata: {"ready":true}\n\n');
          response.once('close', markDisconnected);
          return;
        }
        if (request.url?.startsWith('/workspace/assets/')) {
          const media = Buffer.from([0, 1, 2, 128, 255]);
          response.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes 0-4/5',
            'content-length': media.length,
          });
          response.end(request.method === 'HEAD' ? undefined : media);
          return;
        }
        if (request.url?.startsWith('/project/package/')) {
          response.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="synthetic-project.zip"',
          });
          response.end(Buffer.from([80, 75, 3, 4]));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', 'x-private-backend': 'synthetic' });
        response.end(JSON.stringify({ path: request.url, method: request.method, body }));
      });
    });
    t.after(async () => {
      backend.closeAllConnections();
      if (backend.listening) await new Promise<void>((resolve) => backend.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      backend.once('error', reject);
      backend.listen(0, '127.0.0.1', resolve);
    });
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === 'object');
    privateAuthority = `127.0.0.1:${backendAddress.port}`;
    const metadata = { endpoint: `http://${privateAuthority}`, pid: process.pid };
    await fs.writeFile(endpointFile, JSON.stringify(metadata));

    // The fallback makes overbroad prefix matching observable without loading the
    // repository renderer or involving its existing dirty worktree.
    const fallback: Plugin = {
      name: 'synthetic-unproxied-route',
      configureServer(server) {
        server.middlewares.use((_request, response) => {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end('{"unproxied":true}');
        });
      },
    };
    const vite = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      cacheDir: path.join(root, 'cache'),
      plugins: [developmentHostApi(endpointFile), fallback],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, watch: null, allowedHosts: true },
    });
    t.after(async () => {
      await vite.close();
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('blode-dev-host-api-test-'));
      await fs.rm(resolved, { recursive: true, force: true });
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    assert.ok(address && typeof address === 'object');
    const lanAuthority = `192.0.2.10:${address.port}`;
    const origin = `http://${lanAuthority}`;
    const headers = { host: lanAuthority, origin, referer: `${origin}/#/workspace` };

    const request = (
      url: string,
      options: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ) =>
      new Promise<Reply>((resolve, reject) => {
        const outgoing = requestHttp(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: url,
            method: options.method ?? 'GET',
            headers: { ...headers, ...options.headers },
            agent: false,
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            incoming.once('error', reject);
            incoming.once('end', () =>
              resolve({
                status: incoming.statusCode!,
                headers: incoming.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('Synthetic proxy request timed out')));
        outgoing.once('error', reject);
        outgoing.end(options.body);
      });

    await t.test(
      'LAN authority RPC keeps its body and receives a private backend response without 401',
      async () => {
        const body = JSON.stringify({ method: 'getState', args: ['synthetic'] });
        const reply = await request('/rpc?test=body', {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/json' },
        });
        assert.equal(reply.status, 200);
        assert.equal(reply.headers['x-private-backend'], 'synthetic');
        assert.deepEqual(JSON.parse(reply.body.toString()), { path: '/rpc?test=body', method: 'POST', body });
        assert.deepEqual(observed.at(-1), {
          path: '/rpc?test=body',
          host: privateAuthority,
          origin: undefined,
          referer: undefined,
          body,
        });
      },
    );

    await t.test(
      'SSE delivers a frame before closing and cancellation closes its private upstream',
      async () => {
        const incoming = await within(
          new Promise<IncomingMessage>((resolve, reject) => {
            const outgoing = requestHttp(
              {
                hostname: '127.0.0.1',
                port: address.port,
                path: '/events?client=synthetic',
                headers,
                agent: false,
              },
              resolve,
            );
            outgoing.once('error', reject);
            outgoing.end();
          }),
          'SSE headers were buffered',
        );
        try {
          assert.equal(incoming.statusCode, 200);
          assert.match(String(incoming.headers['content-type']), /text\/event-stream/);
          const first = await within(
            new Promise<Buffer>((resolve, reject) => {
              incoming.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk)));
              incoming.once('error', reject);
            }),
            'SSE first frame was buffered',
          );
          assert.match(first.toString(), /event: ready\ndata: \{"ready":true\}\n\n/);
          assert.equal(
            incoming.readableEnded,
            false,
            'the first event arrives while its stream remains open',
          );
        } finally {
          incoming.destroy();
        }
        await within(disconnected, 'Cancelling SSE did not close its private upstream');
      },
    );

    await t.test('resource, package, UI and debugger routes preserve paths and streamed bytes', async () => {
      const media = await request('/workspace/assets/synthetic?preview=1', {
        headers: { range: 'bytes=0-4' },
      });
      assert.equal(media.status, 206);
      assert.equal(media.headers['content-range'], 'bytes 0-4/5');
      assert.deepEqual(media.body, Buffer.from([0, 1, 2, 128, 255]));
      const head = await request('/workspace/assets/synthetic', { method: 'HEAD' });
      assert.equal(head.status, 206);
      assert.equal(head.body.length, 0);
      const archive = await request('/project/package/synthetic');
      assert.equal(archive.status, 200);
      assert.equal(archive.headers['content-disposition'], 'attachment; filename="synthetic-project.zip"');
      assert.deepEqual(archive.body, Buffer.from([80, 75, 3, 4]));
      for (const url of ['/extension-ui/synthetic', '/runtime-ui/synthetic', '/debugger/symbols']) {
        const reply = await request(url);
        assert.equal(reply.status, 200, url);
        assert.equal(JSON.parse(reply.body.toString()).path, url);
      }
      const count = observed.length;
      for (const url of ['/rpc-other', '/workspace-other', '/project-other']) {
        const reply = await request(url);
        assert.equal(reply.status, 404, url);
        assert.deepEqual(JSON.parse(reply.body.toString()), { unproxied: true });
      }
      assert.equal(observed.length, count, 'lookalike route prefixes stay outside the private API');
    });

    await t.test(
      'cross-origin, malformed and cross-site requests are rejected before forwarding',
      async () => {
        const count = observed.length;
        const rejected: Record<string, string>[] = [
          { origin: 'http://192.0.2.11:5173' },
          { origin: `https://${lanAuthority}` },
          { origin: `${origin}/unexpected-path` },
          { origin: 'null' },
          { 'sec-fetch-site': 'cross-site' },
        ];
        for (const rejectedHeaders of rejected) {
          const reply = await request('/rpc', { method: 'POST', body: '{}', headers: rejectedHeaders });
          assert.equal(reply.status, 403);
        }
        assert.equal(observed.length, count);
      },
    );

    await t.test(
      'missing, invalid and non-loopback endpoint records return 503 without network forwarding',
      async () => {
        const count = observed.length;
        await fs.unlink(endpointFile);
        assert.equal((await request('/rpc', { method: 'POST', body: '{}' })).status, 503);
        for (const invalid of [
          '{broken JSON',
          JSON.stringify({ ...metadata, endpoint: 'http://192.0.2.20:47821' }),
          JSON.stringify({ ...metadata, endpoint: `http://localhost:${backendAddress.port}` }),
          JSON.stringify({ ...metadata, endpoint: `http://user@${privateAuthority}` }),
          JSON.stringify({ ...metadata, endpoint: `http://${privateAuthority}/other` }),
          JSON.stringify({ ...metadata, pid: 0 }),
        ]) {
          await fs.writeFile(endpointFile, invalid);
          const reply = await request('/rpc', { method: 'POST', body: '{}' });
          assert.equal(reply.status, 503);
          assert.equal(JSON.parse(reply.body.toString()).error, 'Desktop backend is not ready');
        }
        assert.equal(observed.length, count, 'invalid metadata cannot select an arbitrary proxy destination');
        await fs.writeFile(endpointFile, JSON.stringify(metadata));
        assert.equal((await request('/rpc', { method: 'POST', body: '{}' })).status, 200);
      },
    );
  },
);

test(
  'real backend view URLs and one-use tickets stay on the public development origin',
  { timeout: 30_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-dev-view-proxy-test-'));
    const close: (() => Promise<void>)[] = [];
    t.after(async () => {
      try {
        for (const shutdown of close.reverse()) await shutdown();
      } finally {
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('blode-dev-view-proxy-test-'));
        await fs.rm(resolved, { recursive: true, force: true });
      }
    });
    const hostServices = {
      invoke: async (method: string): Promise<unknown> => {
        if (method === 'runtimePluginViewInfo') return { location: 'window' };
        if (method === 'runtimePluginView') return '<main>Synthetic runtime view</main>';
        if (method === 'generalExtensionContext') {
          return { enabled: true, manifest: { ui: { views: [{ id: 'appearance', location: 'window' }] } } };
        }
        if (method === 'generalExtensionViewDocument') return '<main>Synthetic extension view</main>';
        throw new Error('Unexpected synthetic host service');
      },
    };
    const backend = await startWebServer({
      api: {} as CoreApi,
      dataRoot: path.join(root, 'private-backend'),
      appRoot: root,
      hostServices,
      isPackaged: false,
      allowExternal: false,
      developmentProxy: true,
      port: 0,
    });
    close.push(() => backend.close());
    const endpointFile = path.join(root, 'desktop-endpoint.json');
    await fs.writeFile(endpointFile, JSON.stringify({ endpoint: backend.endpoint, pid: process.pid }));
    const vite = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      cacheDir: path.join(root, 'cache'),
      plugins: [developmentHostApi(endpointFile)],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, watch: null, allowedHosts: true },
    });
    close.push(() => vite.close());
    await vite.listen();
    const address = vite.httpServer!.address();
    assert.ok(address && typeof address === 'object');
    const publicAuthority = `192.0.2.10:${address.port}`;
    const publicOrigin = `http://${publicAuthority}`;

    // Connect only to owned loopback sockets while presenting the public LAN
    // authority a remote browser uses. No generated token is read or supplied.
    const exchange = (endpoint: string, route: string, headers: Record<string, string>, body?: string) =>
      new Promise<Reply>((resolve, reject) => {
        const outgoing = requestHttp(
          new URL(route, endpoint),
          { method: body === undefined ? 'GET' : 'POST', headers, agent: false },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            incoming.once('error', reject);
            incoming.once('end', () =>
              resolve({
                status: incoming.statusCode!,
                headers: incoming.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        outgoing.once('error', reject);
        outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('Synthetic view request timed out')));
        outgoing.end(body);
      });
    const proxyEndpoint = `http://127.0.0.1:${address.port}`;
    const browserHeaders = {
      host: publicAuthority,
      origin: publicOrigin,
      'content-type': 'application/json',
      // The browser cannot override the proxy's authoritative public origin.
      'x-blode-development-origin': 'http://203.0.113.9:1234',
    };
    const rpc = async (method: string, args: unknown[]) => {
      const reply = await exchange(proxyEndpoint, '/rpc', browserHeaders, JSON.stringify({ method, args }));
      assert.equal(reply.status, 200, `${method}: ${reply.body.toString()}`);
      return JSON.parse(reply.body.toString()) as unknown;
    };

    const runtimeWindow = await rpc('runtimePluginOpenView', ['Fixture', 'inspect']);
    assert.deepEqual(runtimeWindow, {
      destination: 'browser',
      url: `${publicOrigin}/#/runtime-view/Fixture/inspect`,
    });
    const extensionWindow = await rpc('generalExtensionOpenView', [{ id: 'Fixture', view: 'appearance' }]);
    assert.deepEqual(extensionWindow, {
      destination: 'browser',
      url: `${publicOrigin}/#/extension-view/Fixture/appearance`,
    });

    for (const specification of [
      {
        method: 'runtimePluginViewDocument',
        args: ['Fixture', 'view:inspect'],
        prefix: '/runtime-ui/',
        content: 'Synthetic runtime view',
      },
      {
        method: 'generalExtensionViewUrl',
        args: [{ id: 'Fixture', view: 'appearance' }],
        prefix: '/extension-ui/',
        content: 'Synthetic extension view',
      },
    ]) {
      const location = await rpc(specification.method, specification.args);
      assert.equal(typeof location, 'string');
      const ticket = new URL(location as string);
      assert.equal(
        ticket.origin,
        publicOrigin,
        'ticket URL exposes the public listener, never its private backend',
      );
      assert.ok(ticket.pathname.startsWith(specification.prefix));
      assert.match(ticket.pathname.slice(specification.prefix.length), /^[a-f0-9]{48}$/);
      assert.equal(ticket.search, '');
      const document = await exchange(proxyEndpoint, ticket.pathname, browserHeaders);
      assert.equal(document.status, 200);
      assert.match(String(document.headers['content-type']), /text\/html/);
      assert.ok(document.body.toString().includes(specification.content));
      assert.equal(
        (await exchange(proxyEndpoint, ticket.pathname, browserHeaders)).status,
        404,
        'proxied tickets retain one-use consumption',
      );
    }

    for (const mode of [
      { name: 'ordinary loopback backend', isPackaged: false, developmentProxy: false },
      { name: 'packaged backend', isPackaged: true, developmentProxy: true },
    ]) {
      const ordinary = await startWebServer({
        api: {} as CoreApi,
        dataRoot: path.join(root, mode.isPackaged ? 'packaged-backend' : 'ordinary-backend'),
        appRoot: root,
        hostServices,
        isPackaged: mode.isPackaged,
        allowExternal: false,
        developmentProxy: mode.developmentProxy,
        port: 0,
      });
      close.push(() => ordinary.close());
      const reply = await exchange(
        ordinary.endpoint,
        '/rpc',
        {
          'content-type': 'application/json',
          'x-blode-development-origin': publicOrigin,
        },
        JSON.stringify({ method: 'runtimePluginOpenView', args: ['Fixture', 'inspect'] }),
      );
      assert.equal(reply.status, 200, mode.name);
      assert.deepEqual(
        JSON.parse(reply.body.toString()),
        {
          destination: 'browser',
          url: `${ordinary.endpoint}/#/runtime-view/Fixture/inspect`,
        },
        `${mode.name} ignores the development-only forwarding header`,
      );
    }
  },
);
