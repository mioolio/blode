import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readZip } from '../src/core/zip-reader';
import { extractClangdArchive } from '../src/core/clangd/install';
import { writeZip } from '../src/core/zip';

test('clangd archives are bounded, verified and extracted without the release folder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-install-'));
  try {
    const archive = path.join(root, 'clangd.zip');
    await writeZip(
      archive,
      (async function* () {
        yield { path: 'clangd_23.1.0/bin/clangd.exe', data: Buffer.from('binary') };
        yield { path: 'clangd_23.1.0/lib/clang/23/include/stdint.h', data: Buffer.from('header') };
        yield { path: 'clangd_23.1.0/README.txt', data: Buffer.from('readme') };
      })(),
    );
    const files = readZip(await readFile(archive), {
      maxArchive: 256 * 1024 * 1024,
      maxTotal: 512 * 1024 * 1024,
      invalidError: 'error.toolVersionExtract',
      tooLargeError: 'error.toolVersionExtract',
    });
    const target = path.join(root, 'versions', 'clangd', '23.1.0');
    await extractClangdArchive(files, target, 'win32');
    assert.equal(await readFile(path.join(target, 'bin', 'clangd.exe'), 'utf8'), 'binary');
    assert.equal(
      await readFile(path.join(target, 'lib', 'clang', '23', 'include', 'stdint.h'), 'utf8'),
      'header',
    );
    assert.equal((await stat(path.join(target, 'README.txt'))).isFile(), true);

    await assert.rejects(
      extractClangdArchive(
        new Map([['clangd_23.1.0/../escape.txt', Buffer.from('no')]]),
        path.join(root, 'escape'),
        'win32',
      ),
      /error\.toolVersionExtract/,
    );
    await assert.rejects(
      extractClangdArchive(
        new Map([['bin/clangd.exe', Buffer.from('no')]]),
        path.join(root, 'flat'),
        'win32',
      ),
      /error\.toolVersionExtract/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
