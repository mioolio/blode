import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import { createDevelopmentServerIdentity } from '../scripts/dev-server';
import { developmentRendererUrl } from '../src/shared/development-url';

test('development renderer origins accept the actual loopback port and reject remote or decorated URLs', () => {
  for (const port of [5173, 5174, 5281, 61000])
    assert.equal(developmentRendererUrl(`http://127.0.0.1:${port}/`), `http://127.0.0.1:${port}`);
  for (const value of [
    'https://127.0.0.1:5174',
    'http://localhost:5174',
    'http://127.0.0.1.example:5174',
    'http://127.0.0.1:65536',
    'http://user@127.0.0.1:5174',
    'http://127.0.0.1:5174/other',
    'http://127.0.0.1:5174/?token=value',
    'http://127.0.0.1:5174/#/hardware-debugger',
  ])
    assert.throws(() => developmentRendererUrl(value), /invalidDevServer/);
});

test(
  'an occupied development port stays untouched while readiness uses only the owned Vite listener',
  { timeout: 30_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-dev-port-test-'));
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>Owned Blode dev test</title>');
    let occupiedRequests = 0;
    const occupied = createHttpServer((_request, response) => {
      occupiedRequests++;
      response.end('another application');
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(port, '127.0.0.1', () => {
          occupied.removeListener('error', reject);
          resolve();
        });
      });
    try {
      await listen(5173);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await listen(0);
      t.diagnostic(
        '5173 already belongs to another process; collision tested on a separately owned HTTP port.',
      );
    }
    const address = occupied.address();
    assert.ok(address && typeof address === 'object');
    const occupiedOrigin = `http://127.0.0.1:${address.port}`;
    const identity = createDevelopmentServerIdentity();
    const vite = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      cacheDir: path.join(root, 'cache'),
      plugins: [identity.plugin],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: address.port, strictPort: false, open: false, watch: null },
    });
    t.after(async () => {
      await vite.close();
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('blode-dev-port-test-'));
      await fs.rm(root, { recursive: true, force: true });
    });
    await vite.listen();
    // Even misleading advertised URLs cannot redirect the launcher to the other listener.
    if (vite.resolvedUrls) vite.resolvedUrls.local = [occupiedOrigin + '/'];
    const origin = await identity.ready(vite);
    assert.ok(Number(new URL(origin).port) > address.port);
    assert.equal(occupiedRequests, 0, 'startup did not probe or load the occupied application');
    assert.match(await fetch(origin).then((response) => response.text()), /Owned Blode dev test/);
    await assert.rejects(
      identity.ready(vite, async () => new Response('another application')),
      /invalidDevServer/,
    );
    assert.equal(await fetch(occupiedOrigin).then((response) => response.text()), 'another application');
    assert.equal(occupiedRequests, 1);
    assert.equal(occupied.listening, true);
  },
);

test(
  'Vite configuration imports through the native Node TypeScript loader',
  { timeout: 30_000 },
  async () => {
    const config = new URL('../vite.config.ts', import.meta.url);
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {default:config}=await import(${JSON.stringify(config.href)});if(config.server.strictPort!==false)throw Error('strict port');console.log('VITE_NATIVE_CONFIG_OK');`,
      ],
      { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 20_000 },
    );
    assert.match(result.stdout, /VITE_NATIVE_CONFIG_OK/);
    assert.doesNotMatch(
      result.stderr,
      /ERR_MODULE_NOT_FOUND|Failed to load config|native loader failed|MODULE_TYPELESS_PACKAGE_JSON/i,
    );
  },
);
