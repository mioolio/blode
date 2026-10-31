import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { prepareClangdProject } from '../src/core/clangd/compile-commands';

const config = {
  version: 1,
  name: 'arduino-smoke',
  boardId: 'Esp32_S3_CAM',
  port: '',
  baudRate: 115200,
  flashSize: 0,
  partitions: [],
  toolchain: { mode: 'managed', arduinoCli: '', python: '', additionalUrls: [], fqbn: '' },
} as any;

test('existing build compilation database is reused and the sketch gets its real command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-db-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-db-data-'));
  const toolchainRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-db-tools-'));
  try {
    const source = path.join(root, '.blode/build/sketch/demo.ino.cpp');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(
      path.join(root, '.blode/build/compile_commands.json'),
      JSON.stringify([
        {
          directory: root,
          file: source,
          arguments: ['xtensa-esp32s3-elf-g++', '-DARDUINO=10607', '-I', path.join(root, 'core'), source],
        },
      ]),
    );
    const files = [
      { path: 'demo.ino', language: 'cpp', content: 'void setup() { Serial.begin(115200); }\n' },
      { path: 'core/Arduino.h', language: 'c', content: '#pragma once\n' },
    ];
    const result = await prepareClangdProject({
      root,
      files,
      config,
      toolchainRoot,
      dataRoot,
      env: { PATH: '' },
    });
    assert.ok(result.directory.includes(`${path.sep}db-`));
    const commands = JSON.parse(
      await readFile(path.join(result.directory, 'compile_commands.json'), 'utf8'),
    ) as { file: string; arguments: string[] }[];
    const sketch = commands.find((entry) => entry.file.endsWith('demo.ino'));
    assert.ok(sketch, 'sketch entry exists');
    assert.ok(sketch.arguments.includes('-DARDUINO=10607'));
    assert.ok(sketch.arguments.includes('-x'));
    assert.ok(sketch.arguments.includes('c++'));
    assert.ok(sketch.arguments.includes(path.join(root, 'demo.ino')));
    assert.ok(!sketch.arguments.includes('-include'), 'no synthetic prelude');
  } finally {
    await Promise.all(
      [root, dataRoot, toolchainRoot].map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});
