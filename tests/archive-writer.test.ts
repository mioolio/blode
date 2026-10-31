import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BundledArchiveWriter } from '../src/core/archive-writer';
import { readZip } from '../src/core/zip-reader';

test('bundled 7-Zip compresses Unicode names and streamed SDK files without using the fallback', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip('bundled Windows x64 runtime');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-7zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = new BundledArchiveWriter({
    root: path.resolve('vendor/7zip'),
    dataRoot: path.join(root, 'data'),
  });
  const native = path.join(root, 'source.lib');
  const payload = Buffer.alloc(2_000_000, 42);
  await fs.writeFile(native, payload);
  const archive = path.join(root, 'sdk.zip'),
    progress: number[] = [],
    lines: string[] = [];
  await writer.write(
    archive,
    (async function* () {
      yield { path: 'files/中文 空格.h', data: Buffer.from('头文件') };
      yield { path: 'files/[literal].h', data: Buffer.from('literal filename') };
      yield { path: 'files/lib/runtime.a', data: { file: native } };
    })(),
    { onProgress: (n) => progress.push(n), onLine: (line) => lines.push(line) },
  );
  const bytes = await fs.readFile(archive),
    files = readZip(bytes);
  assert.equal(files.get('files/中文 空格.h')?.toString(), '头文件', JSON.stringify([...files.keys()]));
  assert.equal(files.get('files/[literal].h')?.toString(), 'literal filename');
  assert.deepEqual(files.get('files/lib/runtime.a'), payload);
  assert.ok(bytes.length < payload.length / 4);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^status\.archiveEngine: 7-Zip [\d.]+ · ZIP\/Deflate$/);
  assert.equal(progress.at(-1), 100);
});

test('missing 7-Zip falls back to the built-in ZIP engine and reports it once', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-zip-fallback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const writer = new BundledArchiveWriter({ root: path.join(root, 'missing'), dataRoot: root });
  const archive = path.join(root, 'fallback.zip');
  await writer.write(
    archive,
    (async function* () {
      yield { path: 'data.txt', data: Buffer.from('fallback') };
    })(),
    { onLine: (line) => lines.push(line) },
  );
  assert.equal(
    readZip(await fs.readFile(archive))
      .get('data.txt')
      ?.toString(),
    'fallback',
  );
  assert.equal(lines.filter((line) => line === 'status.archiveFallback').length, 1);
  assert.match(lines[0], /^status\.archivePrimaryFailed: /);
});

test('cancelled archive creation never switches engines and cleans up partial output', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return t.skip();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-zip-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const archive = path.join(root, 'cancelled.zip'),
    lines: string[] = [];
  const writer = new BundledArchiveWriter({
    root: path.resolve('vendor/7zip'),
    dataRoot: path.join(root, 'data'),
    runner: async () => {
      await fs.writeFile(archive, 'partial archive');
      controller.abort(new Error('error.operationCancelled'));
      throw controller.signal.reason;
    },
  });
  await assert.rejects(
    writer.write(
      archive,
      (async function* () {
        yield { path: 'file.txt', data: Buffer.from('data') };
      })(),
      { signal: controller.signal, onLine: (line) => lines.push(line) },
    ),
    /operationCancelled/,
  );
  assert.equal(await fs.stat(archive).catch(() => null), null);
  assert.ok(
    !lines.some(
      (line) => line.startsWith('status.archiveFallback') || line.startsWith('status.archivePrimaryFailed'),
    ),
  );
  assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith('.archive-')));
});
