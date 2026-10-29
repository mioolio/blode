import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, createServer } from 'vite';

test(
  'cold Vite startup includes language validation before editor requests without a reload',
  { timeout: 60_000 },
  async (t) => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-vite-cold-test-'));
    const messages: string[] = [];
    const errors: string[] = [];
    const logger = createLogger('silent');
    logger.info = (message) => {
      messages.push(message);
    };
    logger.warn = (message) => {
      messages.push(message);
    };
    logger.warnOnce = logger.warn;
    logger.error = (message) => {
      errors.push(message);
    };
    const server = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      cacheDir,
      customLogger: logger,
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        open: false,
        // Tests need no workspace watcher and must not share the development cache.
        watch: null,
        fs: { allow: [root, cacheDir] },
      },
    });
    t.after(async () => {
      await server.close();
      const resolvedCache = path.resolve(cacheDir);
      assert.equal(path.dirname(resolvedCache), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolvedCache).startsWith('blode-vite-cold-test-'));
      await fs.rm(resolvedCache, { recursive: true, force: true });
    });
    const reloads: unknown[] = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = ((...args: Parameters<typeof send>) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'full-reload')
        reloads.push(payload);
      return send(...args);
    }) as typeof server.ws.send;
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const get = async (url: string) => {
      const response = await fetch(new URL(url, origin), { signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      assert.equal(response.status, 200, `${url}: ${body.slice(0, 600)}`);
      return body;
    };

    const optimizer = server.environments.client.depsOptimizer!;
    assert.ok(optimizer, 'client optimizer is enabled');
    assert.ok(server.config.optimizeDeps.include?.includes('zod'));
    const initialZod = optimizer.metadata.discovered.zod ?? optimizer.metadata.optimized.zod;
    assert.ok(initialZod, 'zod is registered before the first renderer request');
    await get('/');
    await get('/src/renderer/main.tsx');
    await server.environments.client.waitForRequestsIdle();
    await initialZod.processing;
    const firstHash = optimizer.metadata.browserHash;
    assert.ok(optimizer.metadata.optimized.zod, 'the first optimizer batch contains zod');

    // Request the schema and lazy editor after the initial page graph settles.
    // This used to discover zod too late and replace the page during startup.
    const schema = await get('/src/shared/module-languages.ts');
    const zodUrl = schema.match(/from\s*["']([^"']*\/zod\.js\?[^"']*)["']/)?.[1];
    assert.ok(zodUrl, 'the renderer uses the optimized browser zod module');
    await get(zodUrl);
    await get('/src/renderer/editor/CodeEditor.tsx');
    await server.environments.client.waitForRequestsIdle();
    await optimizer.scanProcessing;
    await Promise.all(Object.values(optimizer.metadata.discovered).map((dep) => dep.processing));
    assert.equal(
      optimizer.metadata.browserHash,
      firstHash,
      'optional editor requests keep the initial dependency batch',
    );
    assert.deepEqual(reloads, [], 'dependency optimization must not reload the page');
    assert.deepEqual(errors, [], 'the renderer graph transforms without Vite errors');
    assert.ok(
      !messages.some((message) => /externalized for browser compatibility/.test(message)),
      messages.join('\n'),
    );

    const modules = [...server.environments.client.moduleGraph.idToModuleMap.values()];
    assert.ok(
      modules.some(
        (module) => module.id?.endsWith('/src/shared/module-languages.ts') && module.transformResult,
      ),
    );
    assert.ok(
      !modules.some((module) => /__vite-browser-external|(?:^|\0)node:/.test(module.id ?? '')),
      'renderer imports must not reach Node-only modules',
    );
  },
);
