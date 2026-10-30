import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectFootprint } from '../src/renderer/workspace/resources';
import { MemoryUsage } from '../src/renderer/components/MemoryUsage';
import { I18nProvider } from '../src/renderer/i18n';
import { esp32S3Adapter } from '../extensions/boards/Esp32_S3_CAM/device/adapter';
import { stm32Adapter } from '../extensions/boards/STM32F103C8T6/device/adapter';
import type { AppState } from '../src/shared/contracts';

test('project footprint counts binary files, UTF-8 drafts, and real directory distribution', () => {
  const inventory = {
    entries: [
      { path: 'assets', kind: 'directory' as const, size: 0, editable: false },
      { path: 'assets/table.bin', kind: 'file' as const, size: 2048, editable: false },
      { path: 'main.ino', kind: 'file' as const, size: 3, editable: true },
    ],
    totalBytes: 2051,
    fileCount: 2,
    directoryCount: 1,
    truncated: false,
  };
  const result = projectFootprint(inventory, [], { 'main.ino': '你好' });
  assert.equal(result.totalBytes, 2054);
  assert.equal(result.fileCount, 2);
  assert.equal(result.directoryCount, 1);
  assert.deepEqual(
    result.groups.map((group) => [group.path, group.bytes]),
    [
      ['assets', 2048],
      ['/', 6],
    ],
  );
  assert.equal(inventory.totalBytes, 2051);
});

test('before first build resource panel displays actual configured budgets without inventing usage', () => {
  const config = esp32S3Adapter.createConfig();
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(MemoryUsage, { state: null, config, drafts: {}, stale: false }),
    }),
  );
  assert.match(html, /8 MiB/);
  assert.match(html, /3 MiB/);
  assert.match(html, /未编译|等待|待测|待计算/);
  assert.doesNotMatch(html, /0\.0%/);
});

test('STM32 binary validation shows measured SRAM capacity without inventing linked RAM usage', () => {
  const config = stm32Adapter.createConfigForFlash!(128 * 1024);
  config.programmer!.serialNumber = '0123456789ABCDEF';
  const state: AppState = {
    projectRoot: '/project',
    workspaceOpen: true,
    config,
    build: {},
    files: [],
    inventory: { entries: [], totalBytes: 256, fileCount: 1, directoryCount: 0, truncated: false },
    boards: [stm32Adapter.definition],
    ports: [],
    drivers: [],
    debugProbes: [{ serialNumber: config.programmer!.serialNumber, name: 'ST-Link', ramSize: 20 * 1024 }],
    toolchain: {
      arduinoCli: false,
      esp32Core: false,
      python: false,
      esptool: false,
      stlink: true,
      versions: {},
    },
    lastBuild: {
      success: true,
      flashUsed: 256,
      flashTotal: config.flashSize,
      ramUsed: 0,
      ramTotal: 0,
      artifacts: ['firmware.bin'],
      output: '',
      timestamp: new Date().toISOString(),
    },
    buildStale: false,
    detection: { candidates: [], unavailablePlatforms: [] },
    pipe: { endpoint: '', tokenFile: '' },
    web: { endpoint: '', tokenFile: '', allowExternal: false },
  };
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(MemoryUsage, { state, config, drafts: {}, stale: false }),
    }),
  );
  assert.match(html, /20 KiB/);
  assert.match(html, /固件已验证/);
  assert.match(html, /未测量.*20 KiB/);
  assert.doesNotMatch(html, /0\.0%/);
});

test('program Flash denominator follows the current app allocation after a capacity edit', () => {
  const config = stm32Adapter.createConfigForFlash!(64 * 1024);
  config.partitions[0]!.size = 32 * 1024;
  const state = {
    config,
    build: {},
    files: [],
    inventory: { entries: [], totalBytes: 0, fileCount: 0, directoryCount: 0, truncated: false },
    boards: [stm32Adapter.definition],
    debugProbes: [],
    lastBuild: {
      success: true,
      flashUsed: 2 * 1024,
      flashTotal: 64 * 1024,
      ramUsed: 1024,
      ramTotal: 20 * 1024,
      artifacts: ['firmware.bin'],
      output: '',
      timestamp: new Date().toISOString(),
    },
    buildStale: true,
  } as unknown as AppState;
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      children: createElement(MemoryUsage, { state, config, drafts: {}, stale: true }),
    }),
  );
  assert.match(html, /2 KiB \/ 32 KiB/);
});
