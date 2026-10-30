import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceLanguageIndex } from '../src/shared/language-index';
import { LanguageIndexService } from '../src/core/language-index';

test('workspace navigation distinguishes declarations/definitions and preserves CRLF offsets', () => {
  const index = new WorkspaceLanguageIndex();
  const source =
    '// int phantom(void) { }\r\n#include "driver.h"\r\nint counter = 0;\r\nvoid drive(int value)\r\n{\r\n  int local_value = value;\r\n  counter = value;\r\n}\r\n';
  index.update([
    { path: 'src/main.c', content: source },
    {
      path: 'include/driver.h',
      content:
        '#define ENABLED 1\nvoid drive(int value);\ntypedef struct { int id; } Device;\ntypedef void (*Callback)(int);\n',
    },
    {
      path: 'other/drive.c',
      content: 'void drive(int value) { }\nconst char *label(void) { return "void phantom2(void);"; }',
    },
  ]);
  const drive = index.definitions('drive', 'src/main.c');
  assert.equal(drive.length, 2, 'multiple real implementations remain selectable');
  assert.deepEqual(drive[0], {
    path: 'src/main.c',
    name: 'drive',
    kind: 'function',
    signature: 'void drive(int value)',
    definition: true,
    line: 4,
    column: 6,
    endLine: 4,
    endColumn: 11,
  });
  assert.equal(index.definitions('drive', 'src/main.c', true)[0]?.path, 'include/driver.h');
  assert.equal(index.definitions('phantom', 'src/main.c').length, 0);
  assert.equal(index.definitions('phantom2', 'other/drive.c').length, 0);
  assert.equal(index.definitions('counter', 'src/main.c').length, 1, 'assignments are not declarations');
  assert.equal(
    index.definitions('local_value', 'other/drive.c').length,
    0,
    'function locals do not leak into other files',
  );
  assert.equal(index.definitions('Callback', 'src/main.c')[0]?.kind, 'type');
  assert.equal(index.definitions('Device', 'src/main.c')[0]?.kind, 'type');
  assert.equal(index.definitions('ENABLED', 'src/main.c')[0]?.line, 1);
  assert.equal(index.snapshot().includes[0]?.column, 11);
});

test('include navigation prefers relative files and returns all duplicate fallback headers', () => {
  const index = new WorkspaceLanguageIndex();
  index.update([
    { path: 'src/main.c', content: '#include "driver.h"\n/*\n#include "ghost.h"\n*/' },
    { path: 'src/driver.h', content: '' },
    { path: 'inc/driver.h', content: '' },
    { path: 'a/board.h', content: '' },
    { path: 'b/board.h', content: '' },
  ]);
  assert.deepEqual(index.resolveInclude('src/main.c', 'driver.h'), ['src/driver.h']);
  assert.deepEqual(index.resolveInclude('src/main.c', '../inc/driver.h'), ['inc/driver.h']);
  assert.deepEqual(index.resolveInclude('src/main.c', 'board.h'), ['a/board.h', 'b/board.h']);
  assert.equal(index.snapshot().includes.length, 1);
  assert.deepEqual(index.resolveInclude('src/main.c', '../../outside.h'), []);
});

test('incremental index reparses changed buffers and removes deleted sources', () => {
  const index = new WorkspaceLanguageIndex();
  const one = { path: 'main.c', content: 'void first(void) {}' };
  const two = { path: 'lib/driver.c', content: 'void driver(void) {}' };
  assert.equal(index.update([one, two]), 2);
  assert.equal(index.update([{ ...one }, { ...two }]), 0);
  assert.equal(index.update([{ ...one, content: 'void renamed(void) {}' }, two]), 1);
  assert.equal(index.definitions('first', 'main.c').length, 0);
  assert.equal(index.definitions('renamed', 'main.c').length, 1);
  assert.equal(index.update([one]), 2);
  assert.equal(index.definitions('driver', 'main.c').length, 0);
});

test('incremental discovery preserves previous batches and named lookup does not flatten the workspace', () => {
  const index = new WorkspaceLanguageIndex();
  index.upsert([{ path: 'one.c', content: 'int first(void) { return 1; }' }]);
  index.upsert([{ path: 'two.c', content: '#include "one.h"\nint second(void) { return 2; }' }]);
  index.snapshot = () => {
    throw Error('full snapshot on interactive lookup');
  };
  for (let attempt = 0; attempt < 1000; attempt++)
    assert.deepEqual(index.definitions('missing', 'one.c'), []);
  assert.equal(index.definitions('first', 'two.c')[0].path, 'one.c');
  assert.equal(index.includesForPath('two.c')[0].specifier, 'one.h');
  index.upsert([{ path: 'one.c', content: 'int replaced(void) { return 3; }' }]);
  assert.equal(index.definitions('first', 'two.c').length, 0);
  assert.equal(index.definitions('second', 'one.c').length, 1);
  index.update([]);
  assert.equal(index.definitions('second', 'two.c').length, 0);
});

test('compiler-discovered inc fragments participate in definitions and references', () => {
  const index = new WorkspaceLanguageIndex();
  index.upsert([{ path: 'sdk/detail.inc', content: '#define DETAIL_VALUE 1\nstatic void detail(void) {}' }]);
  assert.equal(index.definitions('DETAIL_VALUE', 'main.c')[0].path, 'sdk/detail.inc');
  assert.equal(index.references('DETAIL_VALUE').length, 1);
});

test('reference indexing yields, cancels without publishing partial data, and reuses unchanged files', async () => {
  const index = new WorkspaceLanguageIndex(),
    content = 'void work(void) {}\r\n' + 'work(); /* work(); */ "work";\r\n'.repeat(3000);
  index.update([
    { path: 'a.c', content },
    { path: 'b.c', content },
  ]);
  let cancelled = false,
    yields = 0;
  assert.deepEqual(
    await index.referencesAsync('work', {
      cancelled: () => cancelled,
      yieldControl: async () => {
        yields++;
        cancelled = true;
      },
    }),
    [],
  );
  assert.equal(yields, 1);
  cancelled = false;
  yields = 0;
  const first = await index.referencesAsync('work', {
    yieldControl: async () => {
      yields++;
    },
  });
  assert.equal(first.length, 6002);
  assert.ok(yields >= 2);
  assert.deepEqual(first[1], { path: 'a.c', line: 2, column: 1, endLine: 2, endColumn: 5 });
  yields = 0;
  assert.deepEqual(
    await index.referencesAsync('work', {
      yieldControl: async () => {
        yields++;
      },
    }),
    first,
  );
  assert.equal(yields, 0);
  first[0].line = 999;
  assert.equal(index.references('work')[0].line, 1, 'callers cannot corrupt cached offsets');
  index.upsert([{ path: 'a.c', content: 'void renamed(void) {}' }]);
  assert.equal((await index.referencesAsync('work')).length, 3001);
});

test('saved index persists to the project cache and never trusts edited cache contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-language-index-'));
  let files = [{ path: 'main.c', language: 'c', content: 'void disk_function(void) {}' }];
  try {
    const service = new LanguageIndexService({
      workspaceSnapshot: async () => ({ projectRoot: root, files }),
    });
    const result = await service.snapshot();
    assert.equal(result.symbols[0]?.name, 'disk_function');
    const cache = path.join(root, '.blode/index/symbols-v1.json');
    assert.equal(JSON.parse(await fs.readFile(cache, 'utf8')).version, 1);
    await fs.writeFile(cache, JSON.stringify({ symbols: [{ name: 'injected_cache_symbol' }] }));
    files = [{ ...files[0], content: 'void new_disk_function(void) {}' }];
    const updated = await service.snapshot();
    assert.equal(updated.symbols[0]?.name, 'new_disk_function');
    assert.ok(!updated.symbols.some((item) => item.name === 'injected_cache_symbol'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
