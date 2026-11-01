import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('patched minimatch supports legacy callers and ASAR unpack filters', async () => {
  const require = createRequire(import.meta.url);
  const minimatch = createRequire(require.resolve('@electron/asar'))('minimatch');
  assert.equal(minimatch('foo/test.node', '**/*.node'), true);
  assert.equal(minimatch.minimatch('a.ts', '*.js'), false);
  assert.equal(new minimatch.Minimatch('*.ts').match('main.ts'), true);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-asar-compat-'));
  try {
    const source = path.join(directory, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'test.node'), 'native fixture');
    await fs.writeFile(path.join(source, 'main.js'), 'module.exports = 1');
    const asar = require('@electron/asar'),
      archive = path.join(directory, 'test.asar');
    await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' });
    assert.ok(asar.listPackage(archive).some((name: string) => name.endsWith('main.js')));
    assert.equal(await fs.readFile(archive + '.unpacked/test.node', 'utf8'), 'native fixture');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
