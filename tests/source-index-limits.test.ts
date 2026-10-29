import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROJECT_SOURCE_LIMITS, readProjectFiles, scanProjectInventory } from '../src/core/workspace';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-source-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a source project with more than 170 files remains fully editable in inventory', async (t) => {
  const root = await fixture(t);
  const names = [
    'main.c',
    'helpers.c',
    'helpers.h',
    ...Array.from({ length: 170 }, (_, index) => `read_${String(index).padStart(3, '0')}.c`),
  ];
  await Promise.all(names.map((name) => fs.writeFile(path.join(root, name), `// ${name}\n`)));
  const files = await readProjectFiles(root);
  assert.equal(files.length, 173);
  assert.deepEqual(new Set(files.map((file) => file.path)), new Set(names));
  const inventory = await scanProjectInventory(root, new Set(files.map((file) => file.path)));
  assert.equal(inventory.entries.filter((entry) => entry.kind === 'file' && entry.editable).length, 173);
  assert.ok(files.some((file) => file.path === 'read_169.c'));
});

test('the editor source index stops at its explicit file count without hiding later inventory entries', async (t) => {
  const root = await fixture(t),
    count = PROJECT_SOURCE_LIMITS.files;
  for (let offset = 0; offset < count + 3; offset += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, count + 3 - offset) }, (_, index) => {
        const name = `file_${String(offset + index).padStart(4, '0')}.c`;
        return fs.writeFile(path.join(root, name), 'int value;\n');
      }),
    );
  const files = await readProjectFiles(root);
  assert.equal(files.length, count);
  assert.equal(files[0].path, 'file_0000.c');
  assert.equal(files.at(-1)?.path, `file_${String(count - 1).padStart(4, '0')}.c`);
  const inventory = await scanProjectInventory(root, new Set(files.map((file) => file.path)));
  assert.equal(inventory.fileCount, count + 3);
  assert.equal(inventory.entries.filter((entry) => entry.editable).length, count);
});

test('UTF8 source byte budgets retain fitting later files and never exceed the total allowance', async (t) => {
  const root = await fixture(t),
    limit = PROJECT_SOURCE_LIMITS;
  const full = Buffer.alloc(limit.fileBytes, 0x61),
    remainder = limit.totalBytes - 16 * limit.fileBytes;
  await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      fs.writeFile(path.join(root, `${String(index).padStart(2, '0')}-full.c`), full),
    ),
  );
  await fs.writeFile(path.join(root, '16-does-not-fit.c'), full);
  await fs.writeFile(path.join(root, '17-exact-fit.c'), '你好'.repeat(remainder / 6));
  await fs.writeFile(path.join(root, '18-no-budget.c'), 'x');
  await fs.writeFile(path.join(root, '19-oversized.c'), Buffer.alloc(limit.fileBytes + 1, 0x61));
  const files = await readProjectFiles(root);
  assert.equal(
    files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    limit.totalBytes,
  );
  assert.ok(files.some((file) => file.path === '17-exact-fit.c'));
  assert.ok(
    !files.some(
      (file) =>
        file.path === '16-does-not-fit.c' || file.path === '18-no-budget.c' || file.path === '19-oversized.c',
    ),
  );
  assert.ok(files.every((file) => Buffer.byteLength(file.content) <= limit.fileBytes));
});

test('nested source trees can open below the former eighth level and stop at the documented depth', async (t) => {
  const root = await fixture(t);
  let directory = root;
  for (let depth = 1; depth <= PROJECT_SOURCE_LIMITS.depth + 1; depth++) {
    directory = path.join(directory, 'd');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, `depth_${depth}.c`), `int depth_${depth};\n`);
  }
  const files = await readProjectFiles(root);
  assert.ok(files.some((file) => file.path.endsWith('depth_12.c')));
  assert.ok(files.some((file) => file.path.endsWith(`depth_${PROJECT_SOURCE_LIMITS.depth}.c`)));
  assert.ok(!files.some((file) => file.path.endsWith(`depth_${PROJECT_SOURCE_LIMITS.depth + 1}.c`)));
});
