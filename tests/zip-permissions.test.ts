import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeZip, type ZipEntry } from '../src/core/zip';

async function archive(entries: ZipEntry[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-zip-mode-'));
  const file = path.join(directory, 'module.zip');
  try {
    await writeZip(
      file,
      (async function* () {
        yield* entries;
      })(),
    );
    return await fs.readFile(file);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^blode-zip-mode-/);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('plugin ZIP preserves executable and data-file permissions in Unix central-directory attributes', async () => {
  const contents = await archive([
    { path: 'module/tools/compiler', data: Buffer.from('#!/bin/sh\necho compiler\n'), mode: 0o100755 },
    { path: 'module/manifest.json', data: Buffer.from('{}'), mode: 0o100644 },
  ]);
  let offset = contents.readUInt32LE(contents.length - 22 + 16);
  for (const mode of [0o100755, 0o100644]) {
    assert.equal(contents.readUInt32LE(offset), 0x02014b50);
    assert.equal(contents.readUInt16LE(offset + 4), (3 << 8) | 20);
    assert.equal(contents.readUInt32LE(offset + 38) >>> 16, mode);
    offset +=
      46 +
      contents.readUInt16LE(offset + 28) +
      contents.readUInt16LE(offset + 30) +
      contents.readUInt16LE(offset + 32);
  }
});

test('ZIP permissions cannot turn file contents into symlinks or setuid executables', async () => {
  const contents = await archive([{ path: 'module/tool', data: Buffer.from('content'), mode: 0o127777 }]);
  const offset = contents.readUInt32LE(contents.length - 22 + 16);
  assert.equal(contents.readUInt32LE(offset + 38) >>> 16, 0o100777);
});

test('existing ZIP callers retain DOS defaults and invalid permission metadata is rejected', async () => {
  const contents = await archive([{ path: 'project/main.c', data: Buffer.from('int main() {}') }]);
  const offset = contents.readUInt32LE(contents.length - 22 + 16);
  assert.equal(contents.readUInt16LE(offset + 4), 20);
  assert.equal(contents.readUInt32LE(offset + 38), 0);
  for (const mode of [-1, NaN, 1.5, 0x10000])
    await assert.rejects(archive([{ path: 'tool', data: Buffer.from(''), mode }]), /invalidArguments/);
});
