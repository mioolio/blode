import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEsp32S3Runtime } from '../extensions/boards/esp32-s3/runtime';
import { Toolchains } from '../extensions/boards/esp32-s3/toolchain';
import { esp32S3Adapter } from '../extensions/boards/esp32-s3/adapter';
import { safeWorkspacePath, readProjectFiles } from '../src/core/workspace';
import type { RuntimeHost } from '../extensions/runtime';
import type { ProjectConfig } from '../src/shared/contracts';

test('ESP32 file/folder entries preserve local includes and refuse declared files outside their staging scope', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-esp-entry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'nested/deep/app/src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'nested/deep/app/main.ino'),
    '#include "local.h"\nvoid setup(){} void loop(){}',
  );
  await fs.writeFile(path.join(root, 'nested/deep/app/local.h'), '#pragma once');
  await fs.writeFile(path.join(root, 'nested/deep/app/src/helper.cpp'), 'int helper(){return 1;}');
  await fs.writeFile(path.join(root, 'outside.h'), 'must stay untouched');
  let compileCalls = 0;
  t.mock.method(Toolchains.prototype, 'status', async () => ({
    arduinoCli: true,
    esp32Core: true,
    python: true,
    esptool: true,
    versions: {},
  }));
  t.mock.method(Toolchains.prototype, 'runCli', async (_config: ProjectConfig, args: string[]) => {
    compileCalls++;
    assert.equal(args[0], 'compile');
    const optimization = compileCalls === 1 ? '-Os' : compileCalls === 2 ? '-O0' : '-O2';
    assert.ok(args.includes(`compiler.c.extra_flags=${optimization} -g`));
    assert.ok(args.includes(`compiler.cpp.extra_flags=${optimization} -g`));
    assert.ok(args.includes('compiler.c.elf.extra_flags=-Wl,--gc-sections'));
    assert.ok(args.every((value) => !value.includes('-flto')));
    const stage = args.at(-1)!;
    assert.match(await fs.readFile(path.join(stage, `${path.basename(stage)}.ino`), 'utf8'), /local.h/);
    assert.equal(await fs.readFile(path.join(stage, 'local.h'), 'utf8'), '#pragma once');
    assert.match(await fs.readFile(path.join(stage, 'src/helper.cpp'), 'utf8'), /helper/);
    await assert.rejects(fs.access(path.join(stage, 'outside.h')));
    const output = args[args.indexOf('--build-path') + 1];
    for (const suffix of ['.ino.bin', '.ino.bootloader.bin', '.ino.partitions.bin'])
      await fs.writeFile(path.join(output, path.basename(stage) + suffix), Buffer.alloc(16));
    return {
      code: 0,
      output: 'Sketch uses 16 bytes.\nGlobal variables use 0 bytes. Maximum is 327680 bytes.',
    };
  });
  const host: RuntimeHost = {
    dataRoot: root,
    signal: new AbortController().signal,
    emit() {},
    projectRoot: () => root,
    readProjectFiles: () => readProjectFiles(root),
    resolveWorkspacePath: (relative, options) => safeWorkspacePath(root, relative, options),
    async resetDirectory(relative) {
      assert.ok(relative === '.blode/build' || relative.startsWith('.blode/staging/'));
      const target = await safeWorkspacePath(root, relative, { internal: true });
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target, { recursive: true });
      return target;
    },
    listPorts: async () => [],
    closeSerial: async () => {},
    requirePort: async () => {
      throw new Error('No device access expected');
    },
    runCommand: async () => {
      throw new Error('No external process expected');
    },
  };
  const runtime = createEsp32S3Runtime(host);
  const config = esp32S3Adapter.createConfig();
  for (const input of [
    { entry: 'nested/deep/app/main.ino' },
    { entry: 'nested/deep/app', settings: { mode: 'debug' as const, optimizeForSize: true } },
    { entry: 'nested/deep/app', settings: { mode: 'release' as const, optimizeForSize: false } },
  ])
    assert.equal((await runtime.build(config, input)).success, true);
  await assert.rejects(
    runtime.build(config, { entry: 'nested/deep/app/main.ino', files: ['outside.h'] }),
    /buildFileOutsideEntry/,
  );
  assert.equal(compileCalls, 3);
  assert.equal(await fs.readFile(path.join(root, 'outside.h'), 'utf8'), 'must stay untouched');
});
