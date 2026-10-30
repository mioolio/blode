import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseProjectBuild } from '../src/core/config';
import {
  compilerChoice as stmChoice,
  optimizationFlags as stmFlags,
} from '../extensions/boards/STM32F103C8T6/compiler/build-settings';
import {
  compilerChoice as espChoice,
  compilerConfig,
  compilerIdentity,
  optimizationFlags as espFlags,
} from '../extensions/boards/Esp32_S3_CAM/compiler/build-settings';
import { esp32S3Adapter } from '../extensions/boards/Esp32_S3_CAM/device/adapter';
import { createEsp32S3Runtime } from '../extensions/boards/Esp32_S3_CAM/runtime/index';
import { Toolchains } from '../extensions/boards/Esp32_S3_CAM/tools/toolchain';
import type { RuntimeHost } from '../extensions/runtime';
import type { BuildSettings } from '../src/shared/build-settings';

test('build settings validate, inherit by language, and explicit auto removes inherited pins', () => {
  const settings: BuildSettings = {
    mode: 'debug',
    optimizeForSize: true,
    common: { family: 'gnu-arm', version: '15.2.1-1.1', directory: '/tools/common' },
    platforms: {
      STM32F103C8T6: { common: { family: 'inherit', directory: '/tools/platform' }, cpp: { family: 'auto' } },
      Esp32_S3_CAM: { common: { family: 'arduino', version: '3.3.2' } },
    },
  };
  assert.deepEqual(parseProjectBuild({ settings }).settings, settings);
  assert.deepEqual(stmChoice(settings, 'c'), {
    family: 'gnu-arm',
    version: '15.2.1-1.1',
    directory: '/tools/platform',
  });
  assert.deepEqual(stmChoice(settings, 'cpp'), { family: 'auto' });
  assert.deepEqual(espChoice(settings, 'cpp'), { family: 'arduino', version: '3.3.2' });
  settings.platforms!.STM32F103C8T6!.c = { family: 'gnu-arm', version: '14.2.1' };
  settings.platforms!['Esp32_S3_CAM']!.cpp = { family: 'arduino', version: '3.3.1' };
  assert.deepEqual(stmChoice(settings, 'c'), { family: 'gnu-arm', version: '14.2.1' });
  assert.deepEqual(espChoice(settings, 'cpp'), { family: 'arduino', version: '3.3.1' });
  for (const flags of [stmFlags, espFlags]) {
    assert.deepEqual(flags(), ['-Os', '-g']);
    assert.deepEqual(flags({ mode: 'release', optimizeForSize: false }), ['-O2', '-g']);
    assert.deepEqual(flags(settings), ['-O0', '-g']);
  }
  for (const invalid of [
    { mode: 'other' },
    { optimizeForSize: 'true' },
    { common: { family: 'shell' } },
    { common: { family: 'gnu-arm', version: '../bad' } },
    { platforms: { unknown: { unexpected: true } } },
    { platforms: { '../outside': {} } },
  ])
    assert.throws(() => parseProjectBuild({ settings: invalid }), /invalidProjectDescriptor/);
});

test('Arduino resolves existing CLI/core selections without downloading and rejects incompatible language pins', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-build-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliDirectory = path.join(root, 'custom-cli');
  const cli = path.join(cliDirectory, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
  const store = path.join(root, 'tools/versions/arduino-esp32/3.3.2');
  await fs.mkdir(cliDirectory, { recursive: true });
  await fs.writeFile(cli, 'fixture');
  await fs.mkdir(path.join(store, 'arduino-data/packages/esp32/hardware/esp32/3.3.2'), { recursive: true });
  const host: RuntimeHost = {
    dataRoot: root,
    toolchainRoot: path.join(root, 'tools'),
    signal: new AbortController().signal,
    emit() {},
    projectRoot: () => root,
    readProjectFiles: async () => [],
    resolveWorkspacePath: async (value) => path.join(root, value),
    resetDirectory: async () => {
      throw Error('must not stage');
    },
    listPorts: async () => [],
    closeSerial: async () => {},
    requirePort: async () => {
      throw Error('must not use hardware');
    },
    runCommand: async () => {
      throw Error('must not start or download tools');
    },
  };
  const config = esp32S3Adapter.createConfig();
  const selected = await compilerConfig(host, config, {
    family: 'arduino',
    directory: cliDirectory,
    arduinoCli: path.join(root, 'ignored'),
    version: '3.3.2',
  });
  assert.equal(selected.toolchain.arduinoCli, cli);
  assert.equal(selected.toolchain.packageDirectory, store);
  const managedCore = path.join(root, 'tools/arduino-data/packages/esp32/hardware/esp32/3.0.7');
  await fs.mkdir(managedCore, { recursive: true });
  const managed = await compilerConfig(host, config, { family: 'arduino', version: '3.0.7' });
  assert.equal(managed.toolchain.packageDirectory, path.join(root, 'tools'));
  assert.notEqual(compilerIdentity(host, config), compilerIdentity(host, selected));
  assert.equal(config.toolchain.packageDirectory, undefined);
  await assert.rejects(
    compilerConfig(host, config, { family: 'arduino', version: '1.0.0' }),
    /buildCompilerVersion/,
  );
  await assert.rejects(
    compilerConfig(host, config, { family: 'arduino', arduinoCli: path.join(root, 'missing') }),
    /buildCompilerPath/,
  );
  await assert.rejects(compilerConfig(host, config, { family: 'gnu-arm' }), /buildCompilerPlatform/);
  const runtime = createEsp32S3Runtime(host);
  await assert.rejects(
    runtime.build(config, {
      settings: {
        platforms: {
          Esp32_S3_CAM: { c: { family: 'arduino', directory: cliDirectory }, cpp: { family: 'auto' } },
        },
      },
    }),
    /buildArduinoConflict/,
  );
  t.mock.method(Toolchains.prototype, 'status', async () => ({
    arduinoCli: true,
    esp32Core: true,
    python: false,
    esptool: false,
    versions: { esp32: '3.3.1' },
  }));
  await assert.rejects(
    runtime.build(config, {
      settings: { common: { family: 'arduino', directory: cliDirectory, version: '3.3.2' } },
    }),
    /buildCompilerVersion/,
  );
});
