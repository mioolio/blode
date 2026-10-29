import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ToolVersions } from '../src/core/tool-versions';
import { discoverInstalledBuildTools } from '../src/core/installed-tools';
import { getBoardAdapter } from '../extensions/registry';

const executable = (value: string) => value + (process.platform === 'win32' ? '.exe' : '');
async function put(directory: string, names: string[]) {
  await fs.mkdir(directory, { recursive: true });
  for (const name of names) await fs.writeFile(path.join(directory, executable(name)), 'test fixture');
}

test('local inventory detects both managed compiler families, versioned installs and PATH without duplicate probes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-installed-tools-'));
  try {
    const gnu = path.join(root, 'armgcc', 'bin');
    const ac6 = path.join(root, 'armclang', 'bin');
    const older = path.join(root, 'versions', 'gnu-arm', '13.3.1-1.1', 'bin');
    const partial = path.join(root, 'versions', 'gnu-arm', '15.2.1-1.1', 'bin');
    await put(gnu, ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy']);
    await put(ac6, ['armclang', 'armlink', 'fromelf']);
    await put(older, ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy']);
    await put(partial, ['arm-none-eabi-gcc']);
    const calls: string[] = [];
    const state = await new ToolVersions({
      root,
      dataRoot: root,
      config: () => getBoardAdapter('stm32').createConfig(),
      env: { PATH: [gnu, ac6, gnu].join(path.delimiter) },
      runner: async (file) => {
        calls.push(file);
        return {
          code: 0,
          output: file.includes('armclang')
            ? 'Arm Compiler for Embedded 6.22'
            : file.startsWith(older)
              ? 'gcc 13.3.1'
              : 'gcc 14.2.1',
        };
      },
    }).toolVersionsState();
    assert.equal(state.installedTools?.length, 3);
    assert.ok(state.installedTools.some((item) => item.family === 'armclang' && item.version === '6.22'));
    assert.ok(
      state.installedTools.some(
        (item) => item.family === 'gnu-arm' && item.version === '13.3.1-1.1' && item.source === 'versioned',
      ),
    );
    assert.ok(!state.installedTools.some((item) => item.directory?.startsWith(partial)));
    assert.equal(new Set(calls).size, calls.length);
    assert.equal(calls.length, 3);
    assert.ok(state.entries.some((item) => item.id === 'gnu-arm:15.2.1-1.1' && !item.installed));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Arduino installed choices pair runnable CLI versions with physical ESP32 core stores', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-arduino-inventory-'));
  try {
    const managedCli = path.join(root, 'bin');
    const oldCli = path.join(root, 'versions', 'arduino-cli', '1.2.2', 'bin');
    await put(managedCli, ['arduino-cli']);
    await put(oldCli, ['arduino-cli']);
    for (const [store, version] of [
      [root, '3.0.7'],
      [path.join(root, 'versions', 'arduino-esp32', '2.0.17'), '2.0.17'],
    ]) {
      const hardware = path.join(store, 'arduino-data/packages/esp32/hardware/esp32', version);
      await fs.mkdir(hardware, { recursive: true });
      await fs.writeFile(path.join(hardware, 'platform.txt'), 'fixture');
      await fs.writeFile(path.join(hardware, 'boards.txt'), 'fixture');
    }
    const falseStore = path.join(root, 'versions/arduino-esp32/1.0.0');
    await fs.mkdir(falseStore, { recursive: true });
    await fs.writeFile(path.join(falseStore, 'installed.json'), '{}');
    const calls: string[] = [];
    const tools = await discoverInstalledBuildTools({
      root,
      config: getBoardAdapter('esp32-s3').createConfig(),
      env: { PATH: managedCli },
      runner: async (file) => {
        calls.push(file);
        return { code: 0, output: `arduino-cli Version: ${file.startsWith(oldCli) ? '1.2.2' : '1.3.1'}` };
      },
    });
    assert.equal(tools.length, 4);
    assert.equal(calls.length, 2);
    assert.deepEqual(new Set(tools.map((item) => item.version)), new Set(['3.0.7', '2.0.17']));
    assert.ok(
      tools.every((item) => item.family === 'arduino' && !!item.arduinoCli && !!item.packageDirectory),
    );
    assert.ok(tools.some((item) => item.name.includes('1.2.2') && item.name.includes('2.0.17')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('explicit build-setting paths are discoverable and select through the existing project path API', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-build-tool-inventory-'));
  try {
    const custom = path.join(root, 'custom', 'bin');
    await put(custom, ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy']);
    const manager = new ToolVersions({
      root: path.join(root, 'managed'),
      dataRoot: root,
      config: () => getBoardAdapter('stm32').createConfig(),
      env: { PATH: '' },
      build: () => ({ settings: { platforms: { stm32: { c: { family: 'gnu-arm', directory: custom } } } } }),
      runner: async () => ({ code: 0, output: 'gcc 12.3.1' }),
    });
    const state = await manager.toolVersionsState();
    assert.equal(state.installedTools?.length, 1);
    const tool = state.installedTools![0];
    assert.equal(tool.source, 'custom');
    assert.deepEqual(await manager.toolVersionSelect({ id: tool.id }), { armCompilerDirectory: custom });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed executable probes are not listed as installed build choices', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-broken-tool-inventory-'));
  try {
    await put(path.join(root, 'armgcc', 'bin'), ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy']);
    const tools = await discoverInstalledBuildTools({
      root,
      config: getBoardAdapter('stm32').createConfig(),
      env: { PATH: '' },
      runner: async () => ({ code: 1, output: 'not runnable' }),
    });
    assert.deepEqual(tools, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
