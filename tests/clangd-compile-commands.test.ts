import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { prepareClangdProject } from '../src/core/clangd/compile-commands';

const config = {
  version: 1,
  name: 'include-smoke',
  boardId: 'auto',
  port: '',
  baudRate: 115200,
  flashSize: 0,
  partitions: [],
  toolchain: { mode: 'managed', arduinoCli: '', python: '', additionalUrls: [], fqbn: '' },
} as any;

test('clangd compile commands include project header directories for quoted includes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-includes-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-includes-data-'));
  const toolchainRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-includes-tools-'));
  try {
    const files = [
      {
        path: 'User/main.c',
        language: 'c',
        content: '#include "stm32f10x.h"\n#include "Delay.h"\nint main(void){return 0;}\n',
      },
      { path: 'Library/stm32f10x.h', language: 'c', content: '#pragma once\n' },
      { path: 'Hardware/Delay.h', language: 'c', content: '#pragma once\n' },
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }
    const result = await prepareClangdProject({
      root,
      files,
      config,
      toolchainRoot,
      dataRoot,
      env: { PATH: '' },
    });
    const commands = JSON.parse(
      await readFile(path.join(result.directory, 'compile_commands.json'), 'utf8'),
    ) as { file: string; arguments: string[] }[];
    const main = commands.find((entry) => entry.file.endsWith('main.c'))!;
    for (const directory of ['Library', 'Hardware']) {
      const absolute = path.join(root, directory);
      assert.ok(main.arguments.includes(absolute), `${directory} include directory`);
      assert.ok(result.fallbackFlags.includes(absolute), `${directory} fallback flag`);
    }
  } finally {
    await Promise.all(
      [root, dataRoot, toolchainRoot].map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});

test('fallback derives include roots recursively from be and the workspace without uvprojx', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-defines-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-defines-data-'));
  const toolchainRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-defines-tools-'));
  try {
    const files = [
      {
        path: 'be',
        language: 'json',
        content: JSON.stringify({ version: 1, build: { entry: 'User/main.c' } }),
      },
      { path: 'Start/stm32f10x.h', language: 'c', content: '#pragma once\n' },
      { path: 'Library/stm32f10x_gpio.h', language: 'c', content: '#pragma once\n' },
      { path: 'System/delay.h', language: 'c', content: '#pragma once\n' },
      {
        path: 'Hardware/OLED.h',
        language: 'c',
        content: '#ifndef OLED_H\n#define OLED_H\nvoid OLED_ShowNum(uint8_t line);\n#endif\n',
      },
      {
        path: 'User/main.c',
        language: 'c',
        content: '#include "stm32f10x.h"\nint main(void){return 0;}\n',
      },
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }
    const result = await prepareClangdProject({
      root,
      files,
      config,
      toolchainRoot,
      dataRoot,
      env: { PATH: '' },
    });
    const commands = JSON.parse(
      await readFile(path.join(result.directory, 'compile_commands.json'), 'utf8'),
    ) as { file: string; arguments: string[] }[];
    const main = commands.find((entry) => entry.file.endsWith('main.c'))!;
    for (const directory of ['Start', 'Library', 'System', 'Hardware', 'User'])
      assert.ok(main.arguments.includes(path.join(root, directory)), directory);
    assert.ok(!main.arguments.some((arg) => arg.startsWith('-D')));
    assert.ok(!main.arguments.includes('-DSTM32F10X_MD'));
    assert.ok(!main.arguments.includes('--target=arm-none-eabi'));
    assert.ok(
      !commands.some((entry) => entry.file.endsWith('OLED.h') || entry.file.endsWith('stm32f10x.h')),
      'no synthetic header translation units',
    );
    assert.ok(!result.fallbackFlags.some((flag) => flag.startsWith('-D')));
  } finally {
    await Promise.all(
      [root, dataRoot, toolchainRoot].map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});

test('STM32 fallback uses the board build model even without uvprojx', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-stm32-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-stm32-data-'));
  const toolchainRoot = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-stm32-tools-'));
  try {
    const files = [
      {
        path: 'be',
        language: 'json',
        content: JSON.stringify({ version: 1, build: { entry: 'User/main.c' } }),
      },
      { path: 'Start/stm32f10x.h', language: 'c', content: '#pragma once\n' },
      { path: 'Hardware/OLED.h', language: 'c', content: '#pragma once\nvoid OLED_Init(void);\n' },
      { path: 'User/main.c', language: 'c', content: '#include "stm32f10x.h"\nint main(void){return 0;}\n' },
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), file.content);
    }
    const result = await prepareClangdProject({
      root,
      files,
      config: { ...config, boardId: 'STM32F103C8T6' },
      toolchainRoot,
      dataRoot,
      env: { PATH: '' },
    });
    const commands = JSON.parse(
      await readFile(path.join(result.directory, 'compile_commands.json'), 'utf8'),
    ) as { file: string; arguments: string[] }[];
    const main = commands.find((entry) => entry.file.endsWith('main.c'))!;
    assert.ok(main.arguments.includes('-DSTM32F10X_MD'));
    assert.ok(main.arguments.includes('--target=arm-none-eabi'));
    assert.ok(main.arguments.includes('-mcpu=cortex-m3'));
    for (const directory of ['Start', 'Hardware', 'User'])
      assert.ok(main.arguments.includes(path.join(root, directory)), directory);
  } finally {
    await Promise.all(
      [root, dataRoot, toolchainRoot].map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});
