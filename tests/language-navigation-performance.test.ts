import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setImmediate as tick } from 'node:timers/promises';
import { getBoardAdapter } from '../extensions/registry';
import { LanguageNavigationService } from '../src/core/language-navigation';
import { WorkspaceLanguageIndex } from '../src/shared/language-index';
import { getCompilerIncludeRoots } from '../src/core/compiler-includes';
import { languageCancelSchema, languageNavigationSchema } from '../src/core/language-schemas';
import { NavigationIo } from '../src/core/language-navigation-work';

async function fixture(t: TestContext, refreshMs = 2000) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-navigation-cache-'));
  const root = path.join(base, 'project'),
    sdk = path.join(base, 'sdk');
  await fs.mkdir(root);
  await fs.mkdir(sdk);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  let current = root;
  const files = [
    { path: 'main.c', language: 'c', content: '#include "umbrella.h"\nint main(void){return 0;}\n' },
  ];
  await fs.writeFile(
    path.join(root, 'compile_commands.json'),
    JSON.stringify([{ directory: root, arguments: ['gcc', '-I', sdk] }]),
  );
  let includes = '';
  for (let i = 0; i < 96; i++) {
    includes += `#include "header${i}.h"\n`;
    await fs.writeFile(
      path.join(sdk, `header${i}.h`),
      '#include "shared.h"\n' +
        Array.from({ length: 60 }, (_, j) => `int api_${i}_${j}(void) { return ${j}; }`).join('\n'),
    );
  }
  await fs.writeFile(path.join(sdk, 'umbrella.h'), includes);
  await fs.writeFile(path.join(sdk, 'shared.h'), '#define SHARED_API 1\n');
  const core = {
    currentProjectRoot: () => current,
    currentConfig: () => config,
    workspaceSnapshot: async () => ({ projectRoot: current, files }),
  };
  const service = new LanguageNavigationService({
    core,
    toolchainRoot: path.join(base, 'tools'),
    env: {},
    refreshMs,
  });
  t.after(() => service.dispose());
  return {
    root,
    sdk,
    base,
    files,
    config,
    service,
    core,
    switchRoot: () => {
      current = path.join(base, 'other');
    },
  };
}
const id = (n: number) => n.toString(16).padStart(32, '0');

test('concurrent missing navigation shares one complete include walk and incrementally parses each header once', async (t) => {
  const f = await fixture(t),
    counts = new Map<string, number>();
  const original = WorkspaceLanguageIndex.prototype.upsert;
  t.mock.method(
    WorkspaceLanguageIndex.prototype,
    'upsert',
    function (this: WorkspaceLanguageIndex, sources: Parameters<typeof original>[0]) {
      for (const source of sources) counts.set(source.path, (counts.get(source.path) ?? 0) + 1);
      return original.call(this, sources);
    },
  );
  const requests = Array.from({ length: 4 }, (_, i) => ({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: i === 3 ? ('reference' as const) : ('definition' as const),
    symbol: `missing_${i}`,
    requestId: id(i),
  }));
  const result = await Promise.all(requests.map((request) => f.service.navigate(request)));
  assert.ok(result.every((items) => items.length === 0));
  assert.equal(f.service.readonlyPaths(f.root).length, 98);
  assert.equal(counts.size, 99);
  assert.ok(
    [...counts.values()].every((value) => value === 1),
    'no full-project reparsing or duplicated issue races',
  );
  const before = [...counts];
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => f.service.navigate({ ...requests[i % 4], requestId: id(i + 10) })),
  );
  assert.deepEqual([...counts], before, 'warm misses do not reparse or rescan SDK sources');
  const [definition] = await f.service.navigate({ ...requests[0], requestId: id(31), symbol: 'api_95_59' });
  assert.match(definition.path, /\/header95\.h$/);
});

test('cancelled and coalesced consumers are independent, last cancellation stops scanning and can resume', async (t) => {
  const f = await fixture(t);
  // Issue one header first so cancellation below exercises the actual traversal rather than preparation.
  await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'include',
    specifier: 'umbrella.h',
  });
  const request = {
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'definition' as const,
    symbol: 'missing_cancelled',
  };
  const first = f.service.navigate({ ...request, requestId: id(1) });
  const firstRejected = assert.rejects(first, /operationCancelled/);
  const second = f.service.navigate({ ...request, requestId: id(2) });
  await tick();
  await f.service.cancel({ expectedProjectRoot: f.root, requestId: id(1) });
  await firstRejected;
  assert.deepEqual(await second, [], 'other consumer still gets a complete answer');
  const fresh = await fixture(t);
  await fresh.service.navigate({
    expectedProjectRoot: fresh.root,
    path: 'main.c',
    kind: 'include',
    specifier: 'umbrella.h',
  });
  const only = fresh.service.navigate({ ...request, expectedProjectRoot: fresh.root, requestId: id(3) });
  const rejected = assert.rejects(only, /operationCancelled/);
  await tick();
  await fresh.service.cancel({ expectedProjectRoot: fresh.root, requestId: id(3) });
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    fresh.service.readonlyPaths(fresh.root).length < 20,
    'cancelled traversal does not finish all 98 headers in the background',
  );
  const [definition] = await fresh.service.navigate({
    ...request,
    expectedProjectRoot: fresh.root,
    symbol: 'api_95_59',
    requestId: id(4),
  });
  assert.match(definition.path, /\/header95\.h$/, 'next request resumes the shared walk');
});

test('workspace edits, compiler configuration and SDK additions/edits invalidate positive and negative results', async (t) => {
  const f = await fixture(t, 0),
    request = { expectedProjectRoot: f.root, path: 'main.c', kind: 'definition' as const, symbol: 'new_api' };
  assert.deepEqual(await f.service.navigate(request), []);
  f.files[0].content += '\nint new_api(void) {return 1;}';
  assert.equal(
    (await f.service.navigate(request))[0].path,
    'main.c',
    'saved/created source immediately defeats a cached miss',
  );
  f.files[0].content = '#include "umbrella.h"\n';
  assert.deepEqual(
    await f.service.navigate(request),
    [],
    'removed definition cannot survive a positive cache',
  );
  await fs.appendFile(path.join(f.sdk, 'header95.h'), '\nint new_api(void) {return 2;}');
  assert.match((await f.service.navigate(request))[0].path, /header95\.h$/);
  await fs.writeFile(path.join(f.sdk, 'new.h'), 'int new_header_api(void) {return 3;}');
  await fs.appendFile(path.join(f.sdk, 'umbrella.h'), '\n#include "new.h"\n');
  assert.match((await f.service.navigate({ ...request, symbol: 'new_header_api' }))[0].path, /new\.h$/);
  const custom = path.join(f.base, 'custom-compiler');
  await fs.mkdir(path.join(custom, 'include'), { recursive: true });
  await fs.writeFile(path.join(custom, 'include', 'custom.h'), 'int custom_compiler_api(void){return 4;}');
  f.config.toolchain.armCompilerDirectory = custom;
  f.files[0].content += '\n#include "custom.h"\n';
  assert.match(
    (await f.service.navigate({ ...request, symbol: 'custom_compiler_api' }))[0].path,
    /custom\.h$/,
  );
  f.switchRoot();
  await assert.rejects(f.service.navigate(request), /collaborationProjectChanged/);
});

test('cancellation contract rejects invalid IDs, supports cancel-before-start and aborts compiler discovery', async (t) => {
  const f = await fixture(t),
    request = {
      expectedProjectRoot: f.root,
      path: 'main.c',
      kind: 'definition' as const,
      symbol: 'missing',
      requestId: id(8),
    };
  assert.equal(languageNavigationSchema.safeParse(request).success, true);
  assert.equal(languageNavigationSchema.safeParse({ ...request, requestId: 'not-an-id' }).success, false);
  assert.equal(
    languageCancelSchema.safeParse({ expectedProjectRoot: f.root, requestId: id(8) }).success,
    true,
  );
  await f.service.cancel({ expectedProjectRoot: f.root, requestId: id(8) });
  await assert.rejects(f.service.navigate(request), /operationCancelled/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    getCompilerIncludeRoots({
      workspace: await f.core.workspaceSnapshot(),
      config: f.config,
      toolchainRoot: path.join(f.base, 'tools'),
      env: {},
      signal: controller.signal,
    }),
    /operationCancelled/,
  );
  assert.deepEqual(await f.service.navigate({ ...request, requestId: id(9) }), []);
});

test('rapid cancellation during preparation and a root switch never poison the next navigation request', async (t) => {
  const f = await fixture(t),
    request = { expectedProjectRoot: f.root, path: 'main.c', kind: 'definition' as const, symbol: 'missing' };
  const initial = f.service.navigate({ ...request, requestId: id(20) });
  const rejected = assert.rejects(initial, /operationCancelled/);
  await tick();
  await f.service.cancel({ expectedProjectRoot: f.root, requestId: id(20) });
  const next = f.service.navigate({ ...request, requestId: id(21), symbol: 'api_95_59' });
  await rejected;
  assert.match((await next)[0].path, /header95\.h$/);
  const old = f.service.navigate({ ...request, kind: 'reference', requestId: id(22) });
  const oldRejected = assert.rejects(old, /operationCancelled|collaborationProjectChanged/);
  f.switchRoot();
  await f.service.cancel({ expectedProjectRoot: f.root, requestId: id(22) });
  await oldRejected;
  assert.deepEqual(f.service.readonlyPaths(f.root), []);
});

test('filesystem limiter bounds all requests together and releases failed operations', async () => {
  const io = new NavigationIo();
  let active = 0,
    maximum = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, (_, index) =>
      io.run(async () => {
        maximum = Math.max(maximum, ++active);
        try {
          await tick();
          if (index % 7 === 0) throw new Error('expected filesystem failure');
          return index;
        } finally {
          active--;
        }
      }),
    ),
  );
  assert.equal(maximum, 8);
  assert.equal(active, 0);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 42);
  assert.equal(await io.run(async () => 99), 99);
});

test('rapidly replacing missing symbols cancels obsolete work and leaves the last target usable', async (t) => {
  const f = await fixture(t),
    outcomes: Promise<unknown>[] = [];
  await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'include',
    specifier: 'umbrella.h',
  });
  for (let index = 0; index < 30; index++) {
    const requestId = id(index + 100);
    outcomes.push(
      f.service
        .navigate({
          expectedProjectRoot: f.root,
          path: 'main.c',
          kind: 'definition',
          symbol: 'obsolete_symbol_' + index,
          requestId,
        })
        .catch((error) => {
          assert.match(String(error), /operationCancelled/);
        }),
    );
    await tick();
    await f.service.cancel({ expectedProjectRoot: f.root, requestId });
  }
  const final = await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'definition',
    symbol: 'api_95_59',
    requestId: id(199),
  });
  await Promise.all(outcomes);
  assert.match(final[0].path, /header95\.h$/);
});
