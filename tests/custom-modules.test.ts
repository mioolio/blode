import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { getBoardAdapter } from '../extensions/registry';
import { createCustomRuntime, customBuildArguments } from '../extensions/custom-runtime';
import type { RuntimeHost } from '../extensions/runtime';
import { parseConfig } from '../src/core/config';
import { FirmwareStore } from '../src/core/firmware';
import { packageRuntime } from '../scripts/package-runtime';
import { resizeFixedLayout } from '../src/renderer/workspace/layout';

test('custom modules accept model names and FQBNs beyond the fixed profiles, with range validation', () => {
  for (const id of ['STM_custom', 'ESP_custom']) {
    const adapter = getBoardAdapter(id);
    const config = adapter.createConfig();
    config.runtime!.values!.chip = id === 'STM_custom' ? 'STM32H743VIT6' : 'esp32c6';
    if (id === 'ESP_custom') config.runtime!.values!.fqbn = 'esp32:esp32:esp32c6';
    assert.equal(parseConfig(config).boardId, id);
    assert.equal(adapter.definition.runtimePlugin?.support.status, 'experimental');
    const broken = structuredClone(config);
    broken.partitions[0].size = config.flashSize + 1;
    assert.throws(() => adapter.validateConfig(broken), /invalidPartition/);
    if (id === 'ESP_custom') assert.equal(adapter.getFqbn(config), 'esp32:esp32:esp32c6');
  }
});

test('custom build arguments preserve spaces as arguments without invoking a shell', () => {
  const config = getBoardAdapter('STM_custom').createConfig();
  config.runtime!.values!.buildArguments = '["--build","{root}/build dir","--out={output}","{entry}"]';
  assert.deepEqual(customBuildArguments(config, { root: 'C:/my project', output: 'C:/out', entry: 'src' }), [
    '--build',
    'C:/my project/build dir',
    '--out=C:/out',
    'src',
  ]);
  config.runtime!.values!.buildArguments = '[1]';
  assert.throws(() => customBuildArguments(config, {}), /invalidBuildArguments/);
});

test('custom firmware selection and programming uses the selected chip/address and detects byte changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-custom-test-'));
  try {
    const file = path.join(directory, 'image.bin');
    const bytes = Buffer.alloc(256, 0x5a);
    await fs.writeFile(file, bytes);
    const calls: { command: string; args: string[] }[] = [];
    const host: RuntimeHost = {
      dataRoot: directory,
      signal: new AbortController().signal,
      emit() {},
      projectRoot: () => directory,
      listPorts: async () => [{ path: 'COM9' }],
      requirePort: async (port) => port!,
      closeSerial: async () => {},
      readProjectFiles: async () => [],
      resetDirectory: async (relative) => {
        const target = path.join(directory, relative);
        await fs.mkdir(target, { recursive: true });
        return target;
      },
      resolveWorkspacePath: async (relative) => path.join(directory, relative),
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, output: 'ok' };
      },
    };
    const store = new FirmwareStore(path.join(directory, 'data'));
    const selected = await store.choose(file);
    for (const id of ['STM_custom', 'ESP_custom']) {
      const adapter = getBoardAdapter(id),
        config = adapter.createConfig();
      config.port = 'COM9';
      config.runtime!.values!.chip = id === 'ESP_custom' ? 'esp32c6' : 'STM32H743';
      if (config.programmer) config.programmer.serialNumber = '1234567890ABCDEF';
      const runtime = createCustomRuntime(host, adapter);
      await store.withImage(selected.id, id, undefined, (image) => runtime.flashPrepared!(config, image));
      const call = calls.at(-1)!;
      if (id === 'STM_custom') assert.ok(call.args.includes('0x8000000'));
      else {
        assert.ok(call.args.includes('esp32c6'));
        assert.ok(call.args.includes('COM9'));
      }
      await assert.rejects(
        runtime.flashPrepared!(config, {
          path: file,
          address: id === 'STM_custom' ? 0x08000000 : 0,
          size: bytes.length,
          sha256: createHash('sha256').update('wrong bytes').digest('hex'),
        }),
        /fileChanged/,
      );
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('custom modules package as standalone JS and preserve their own configuration when loaded', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-custom-package-test-'));
  try {
    for (const id of ['STM_custom', 'ESP_custom']) {
      const result = await packageRuntime({
        source: path.resolve('extensions/boards', id),
        output: directory,
      });
      const payload = path.join(directory, id + '_Module');
      assert.ok(result);
      const manifest = JSON.parse(await fs.readFile(path.join(payload, 'manifest.json'), 'utf8'));
      const module = await import(pathToFileURL(path.join(payload, manifest.runtime)).href);
      const runtime = await module.createRuntime({ toolchainRoot: directory, dataRoot: directory }, manifest);
      assert.equal(runtime.id, id + '_Module');
      assert.equal(typeof runtime.flashPrepared, 'function');
      assert.equal(manifest.debugger.mode, 'none');
      assert.ok(!(await fs.readFile(path.join(payload, manifest.runtime), 'utf8')).includes('src/core'));
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('shrinking Flash clips the tail and removes regions outside the new capacity', () => {
  const config = getBoardAdapter('STM_custom').createConfig();
  config.partitions = [
    { id: 'firmware', name: 'firmware', type: 'app', offset: 0, size: 32768 },
    { id: 'data', name: 'data', type: 'data', offset: 32768, size: 32768 },
  ];
  const resized = resizeFixedLayout(config, 48 * 1024);
  assert.equal(resized.partitions[1].size, 16 * 1024);
  assert.doesNotThrow(() => getBoardAdapter('STM_custom').validateConfig(resized));
  assert.equal(resizeFixedLayout(config, 16 * 1024).partitions.length, 1);
});
