import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistBuildEntry, loadProjectDescriptor } from '../src/core/workspace';
import { getBoardAdapter } from '../extensions/registry';
import { parseProjectDescriptor } from '../src/core/config';
import { createCore } from '../src/core/service';
import { SerialConnection } from '../src/core/serial';
import { Drivers } from '../src/core/drivers';

test('file, directory and root entries persist other build inputs and survive config saves/reopening', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-entry-'));
  const config = getBoardAdapter('auto').createConfig();
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/main.c'), 'int main(void) { for (;;) {} }');
  await fs.writeFile(
    path.join(root, 'be'),
    JSON.stringify({ ...config, build: { files: ['src/main.c'], sketch: 'legacy.ino' } }),
  );
  t.mock.method(SerialConnection, 'list', async () => []);
  t.mock.method(Drivers.prototype, 'statuses', async () => []);
  let builds = 0;
  const core = await createCore({
    projectRoot: root,
    dataRoot: root,
    onEvent: () => {},
    createRuntimes: () => [
      {
        id: 'STM32F103C8T6',
        transport: 'stlink',
        sourceInputs: [],
        status: async () => ({
          arduinoCli: false,
          esp32Core: false,
          python: false,
          esptool: false,
          versions: {},
        }),
        discover: async () => [],
        probe: async () => {
          throw new Error('no probe expected');
        },
        install: async () => {
          throw new Error('no install expected');
        },
        build: async () => {
          builds++;
          throw new Error('no build expected');
        },
        flash: async () => {
          throw new Error('no flash expected');
        },
        invalidate() {},
      },
    ],
  });
  t.after(async () => {
    await core.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const entry of ['src/main.c', 'src', '.']) {
    await core.setBuildEntry(entry);
    assert.equal((await core.getState()).build.entry, entry);
    assert.deepEqual((await loadProjectDescriptor(root, config)).build, {
      entry,
      files: ['src/main.c'],
      sketch: 'legacy.ino',
    });
  }
  await core.saveConfig({ ...config, name: 'renamed' });
  assert.equal((await loadProjectDescriptor(root, config)).build.entry, '.');
  assert.equal(builds, 0);
  for (const invalid of ['../escape', '.blode', 'src/../main.c', 'C:\\outside', '', 'missing.c'])
    await assert.rejects(core.setBuildEntry(invalid));
  assert.equal((await core.getState()).build.entry, '.');
  await core.saveFile(
    'be',
    JSON.stringify({ ...config, name: 'edited descriptor', build: { entry: 'src' } }),
  );
  const edited = await core.getState();
  assert.equal(edited.build.entry, 'src');
  assert.equal(edited.config.name, 'edited descriptor');
  await assert.rejects(core.saveFile('be', '{broken'), /invalidProjectDescriptor/);
  assert.equal((await core.getState()).build.entry, 'src');
});

test('entry setter rejects symbolic links and keeps a valid descriptor unchanged', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-entry-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = getBoardAdapter('auto').createConfig();
  await fs.writeFile(path.join(root, 'be'), JSON.stringify(config));
  await fs.symlink(root, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(persistBuildEntry(root, config, 'link'), /symlinkPath/);
  const descriptor = parseProjectDescriptor(JSON.parse(await fs.readFile(path.join(root, 'be'), 'utf8')));
  assert.deepEqual(descriptor.build, {});
});
