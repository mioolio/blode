import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { startWebServer, type WebServerHandle } from '../src/core/web';
import { CollaborationService } from '../src/core/collaboration';
import { AiAssistance } from '../src/core/ai-assistance';
import { UiCommands } from '../src/core/ui-commands';
import { createAssistanceRoutes } from '../src/core/assistance-routes';
import type { CoreService } from '../src/core/service';

test('shared development browser entry serves same-origin assets instead of redirecting LAN visitors to loopback Vite', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blode-lan-entry-'));
  await mkdir(path.join(directory, 'dist/renderer/assets'), { recursive: true });
  await writeFile(
    path.join(directory, 'dist/renderer/index.html'),
    '<title>LAN workspace</title><script src="/assets/app.js"></script>',
  );
  await writeFile(path.join(directory, 'dist/renderer/assets/app.js'), 'window.lanReady=true;');
  let server: WebServerHandle | undefined;
  try {
    for (const allowExternal of [false, true]) {
      server = await startWebServer({
        api: {} as CoreService,
        dataRoot: directory,
        appRoot: directory,
        isPackaged: false,
        rendererUrl: 'http://127.0.0.1:5174',
        allowExternal,
        requireToken: true,
        port: 0,
      });
      const base = new URL(server.endpoint);
      base.hostname = '127.0.0.1';
      const entry = await fetch(base, { redirect: 'manual' });
      assert.equal(entry.status, allowExternal ? 200 : 302);
      if (allowExternal) {
        assert.equal(entry.headers.get('location'), null);
        assert.match(await entry.text(), /LAN workspace/);
        assert.equal(await (await fetch(new URL('/assets/app.js', base))).text(), 'window.lanReady=true;');
        const denied = await fetch(new URL('/rpc', base), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'getState', args: [] }),
        });
        assert.equal(denied.status, 401);
        await denied.text();
      } else {
        assert.equal(entry.headers.get('location'), 'http://127.0.0.1:5174');
        await entry.text();
      }
      await server.close();
      server = undefined;
    }
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('two HTTP collaborators merge independent edits, retain conflicts and replay only latest logs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blode-collab-web-'));
  const workspace = { projectRoot: '/workspace', files: [{ path: 'main.c', content: 'aa\nbb\ncc\n' }] };
  let server: WebServerHandle | undefined;
  const collaboration = new CollaborationService({
    workspace: async () => structuredClone(workspace),
    saveFile: async (file, text) => {
      workspace.files.find((item) => item.path === file)!.content = text;
    },
    publish: (event) => server?.publishCollaboration(event),
  });
  const ui = new UiCommands(() => {});
  const ai = new AiAssistance({ dataRoot: directory, projectRoot: () => workspace.projectRoot });
  const core = { getState: async () => ({}) } as unknown as CoreService;
  const assistance = createAssistanceRoutes(ai, collaboration, ui);
  const abort = new AbortController();
  try {
    server = await startWebServer({
      api: core,
      assistance,
      dataRoot: directory,
      appRoot: directory,
      isPackaged: true,
      allowExternal: false,
      port: 0,
    });
    const rpc = async (method: string, args: unknown[], headers: Record<string, string> = {}) => {
      const response = await fetch(server!.endpoint + '/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ method, args }),
      });
      return { status: response.status, value: await response.json() };
    };
    const opened = await rpc('collaborationOpen', ['/workspace', 'main.c']);
    assert.equal(opened.status, 200);
    for (const [peer, name] of [
      ['alice', 'Alice'],
      ['bob', 'Bob'],
    ]) {
      const result = await rpc('collaborationPresence', [
        {
          projectRoot: '/workspace',
          identity: { userId: peer, peerId: peer, name },
          actorToken: (peer === 'alice' ? 'a' : 'b').repeat(64),
          path: 'main.c',
          startLine: 2,
          endLine: 3,
          editing: false,
        },
      ]);
      assert.equal(result.status, 200);
    }
    const base = {
      projectRoot: '/workspace',
      session: opened.value.session,
      path: 'main.c',
      baseRevision: 0,
    };
    const first = await rpc('collaborationEdit', [
      {
        ...base,
        peerId: 'alice',
        actorToken: 'a'.repeat(64),
        requestId: 'a1',
        changes: [{ start: 0, end: 2, text: 'AA' }],
      },
    ]);
    const second = await rpc('collaborationEdit', [
      {
        ...base,
        peerId: 'bob',
        actorToken: 'b'.repeat(64),
        requestId: 'b1',
        changes: [{ start: 6, end: 8, text: 'CC' }],
      },
    ]);
    assert.equal(first.value.status, 'applied');
    assert.equal(second.value.document.content, 'AA\nbb\nCC\n');
    const overlap = await rpc('collaborationEdit', [
      {
        ...base,
        peerId: 'bob',
        actorToken: 'b'.repeat(64),
        requestId: 'b2',
        changes: [{ start: 0, end: 2, text: 'ZZ' }],
      },
    ]);
    assert.equal(overlap.value.status, 'conflict');
    assert.equal(overlap.value.document.content, 'AA\nbb\nCC\n');
    const snapshot = await rpc('collaborationState', []);
    assert.equal(snapshot.value.peers.length, 2);
    assert.equal(new Set(snapshot.value.peers.map((peer: any) => peer.userId)).size, 2);
    const rejected = await rpc('collaborationLeave', ['alice'], { origin: 'https://untrusted.example' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.value.error, 'rpc.unauthorized');
    assert.equal((await rpc('collaborationState', [])).value.peers.length, 2);
    assert.equal((await rpc('aiAssistanceState', [])).value.predictionEnabled, false);
    const webGlobal = await rpc('collaborationUndo', [
      {
        projectRoot: base.projectRoot,
        session: base.session,
        path: base.path,
        peerId: 'alice',
        actorToken: 'a'.repeat(64),
        requestId: 'undo-global',
        direction: 'undo',
        scope: 'global',
      },
    ]);
    assert.equal(webGlobal.status, 400);
    assert.equal(webGlobal.value.error, 'error.collaborationGlobalUndoForbidden');
    const spoof = await rpc('collaborationUndo', [
      {
        projectRoot: base.projectRoot,
        session: base.session,
        path: base.path,
        peerId: 'alice',
        actorToken: 'b'.repeat(64),
        requestId: 'undo-spoof',
        direction: 'undo',
        scope: 'own',
      },
    ]);
    assert.equal(spoof.status, 400);
    assert.equal(spoof.value.error, 'error.collaborationActorMismatch');
    for (const message of ['status.buildStarted', 'old-build-log', 'status.buildStarted', 'latest-build-log'])
      server.publish({ kind: 'status', level: 'info', message, time: new Date().toISOString() });
    const response = await fetch(server.endpoint + '/events', {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
    });
    const reader = response.body!.getReader();
    let frames = '';
    while (!frames.includes('latest-build-log')) {
      const next = await reader.read();
      if (next.done) break;
      frames += new TextDecoder().decode(next.value);
    }
    assert.ok(frames.includes('latest-build-log'));
    assert.ok(!frames.includes('old-build-log'));
    server.publishCollaboration({ type: 'presence', snapshot: snapshot.value });
    while (!frames.includes('event: blode:collaboration')) {
      const next = await reader.read();
      if (next.done) break;
      frames += new TextDecoder().decode(next.value);
    }
    assert.ok(frames.includes('event: blode:collaboration'));
    abort.abort();
  } finally {
    abort.abort();
    await server?.close();
    collaboration.dispose();
    ui.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('headless HTTP requires loopback credentials and limits host RPC plus package downloads', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blode-host-web-'));
  const artifactId = '550e8400-e29b-41d4-a716-446655440000';
  const archive = Buffer.from('PK\x03\x04test archive');
  await writeFile(path.join(directory, 'share.zip'), archive);
  const calls: { method: string; args: unknown[] }[] = [];
  const downloads: string[] = [];
  const server = await startWebServer({
    api: { getState: async () => ({ ready: true }) } as unknown as CoreService,
    hostServices: {
      invoke: async (method, args) => {
        calls.push({ method, args });
        return { method };
      },
    },
    packageDownload: (id) => {
      downloads.push(id);
      return id === artifactId ? { path: path.join(directory, 'share.zip'), name: '工程.zip' } : undefined;
    },
    dataRoot: directory,
    appRoot: directory,
    isPackaged: true,
    allowExternal: false,
    requireToken: true,
    port: 0,
  });
  const token = await readFile(server.tokenFile, 'utf8');
  const rpc = async (method: string, headers: Record<string, string> = {}, args: unknown[] = []) =>
    fetch(server.endpoint + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ method, args }),
    });
  try {
    assert.equal((await rpc('getState')).status, 401);
    assert.equal((await rpc('getState', { 'x-blode-token': 'incorrect' })).status, 401);
    assert.equal((await fetch(server.endpoint + '/events')).status, 401);
    assert.equal((await fetch(server.endpoint + '/project/package/' + artifactId)).status, 401);
    for (const method of [
      'gitState',
      'toolVersionList',
      'hostBrowse',
      'projectPackage',
      'terminalWrite',
      'listRecentProjects',
      'openRecentProject',
      'removeRecentProject',
      'closeProject',
      'firmwareChoosePath',
      'firmwareExportPath',
      'firmwareFlash',
    ]) {
      const response = await rpc(method, { 'x-blode-token': token }, ['host-argument']);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { method });
    }
    assert.equal(calls.length, 12);
    assert.deepEqual(calls[0].args, ['host-argument']);
    const unknown = await rpc('execArbitraryCommand', { 'x-blode-token': token });
    assert.equal(unknown.status, 400);
    assert.equal(calls.length, 12);
    const response = await fetch(
      `${server.endpoint}/project/package/${artifactId}?token=${token}&path=${encodeURIComponent('C:/secret.txt')}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition')!, /filename\*=UTF-8''%E5%B7%A5%E7%A8%8B\.zip/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), archive);
    assert.deepEqual(downloads, [artifactId]);
    const missing = await fetch(server.endpoint + '/project/package/550e8400-e29b-41d4-a716-446655440001', {
      headers: { 'x-blode-token': token },
    });
    assert.equal(missing.status, 404);
    const invalid = await fetch(server.endpoint + '/project/package/C%3A%2Fsecret.txt', {
      headers: { 'x-blode-token': token },
    });
    assert.equal(invalid.status, 404);
    assert.equal(downloads.length, 2, 'invalid paths never reach the trusted artifact resolver');
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('all RPCs reject foreign Origin, DNS rebinding Host and non JSON requests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blode-web-origin-'));
  let builds = 0;
  const server = await startWebServer({
    api: {
      getState: async () => ({ ready: true }),
      build: async () => {
        builds++;
      },
    } as unknown as CoreService,
    dataRoot: directory,
    appRoot: directory,
    isPackaged: true,
    allowExternal: false,
    port: 0,
  });
  const rpc = (headers: Record<string, string>, method = 'build') =>
    fetch(server.endpoint + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ method, args: [] }),
    });
  const hostRpc = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        server.endpoint + '/rpc',
        { method: 'POST', headers: { host, 'content-type': 'application/json; charset=utf-8' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ method: 'getState', args: [] }));
    });
  try {
    assert.equal((await rpc({ origin: 'https://untrusted.example' })).status, 400);
    assert.equal((await rpc({ origin: 'null' })).status, 400);
    assert.equal((await rpc({ origin: 'http://localhost.attacker.example' })).status, 400);
    for (const host of ['rebind.attacker.example', 'localhost.attacker.example', '[::invalid]:123']) {
      assert.equal(await hostRpc(host), 400, host);
    }
    assert.equal((await rpc({ 'content-type': 'text/plain' })).status, 415);
    assert.equal(builds, 0);
    for (const origin of [server.endpoint, 'http://localhost:5173', 'http://[::1]:5173']) {
      assert.equal((await rpc({ origin }, 'getState')).status, 200);
    }
    assert.equal(await hostRpc('[::1]:47821'), 200);
    assert.equal(
      (
        await fetch(server.endpoint + '/rpc', {
          method: 'OPTIONS',
          headers: { origin: 'https://untrusted.example' },
        })
      ).status,
      403,
    );
    const malformed = await fetch(server.endpoint + '/%E0%A4');
    assert.equal(malformed.status, 400);
    assert.equal((await rpc({}, 'getState')).status, 200, 'malformed requests leave server available');
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged browser assets use ETags for normal reload and immutable hashed chunks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blode-web-cache-'));
  const renderer = path.join(directory, 'dist', 'renderer');
  await mkdir(path.join(renderer, 'assets'), { recursive: true });
  await writeFile(path.join(renderer, 'index.html'), '<main>Blode</main>');
  await writeFile(path.join(renderer, 'assets', 'editor-abcdef123.js'), 'export const ready=true;');
  const server = await startWebServer({
    api: {} as CoreService,
    dataRoot: directory,
    appRoot: directory,
    isPackaged: true,
    allowExternal: false,
    port: 0,
  });
  try {
    const first = await fetch(server.endpoint + '/');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    await first.text();
    const refreshed = await fetch(server.endpoint + '/', { headers: { 'if-none-match': etag! } });
    assert.equal(refreshed.status, 304);
    assert.equal(await refreshed.text(), '');
    const chunk = await fetch(server.endpoint + '/assets/editor-abcdef123.js');
    assert.match(chunk.headers.get('cache-control')!, /immutable/);
    await chunk.text();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
