import test from 'node:test';
import assert from 'node:assert/strict';
import { getBoardAdapter, listBoards } from '../extensions/registry';
import { parseConfig, parseProjectBuild, parseProjectDescriptor } from '../src/core/config';
import { canonicalBoardId, migrateLegacyBuildPlatforms } from '../src/shared/runtime-identity';
import { readProjectSettings, writeProjectSettings } from '../src/renderer/workspace/projectSettings';

test('canonical runtime profiles have exact names and legacy descriptors retain their configuration', () => {
  for (const [legacy, canonical] of [
    ['esp32-s3', 'Esp32_S3_CAM'],
    ['stm32', 'STM32F103C8T6'],
  ]) {
    const adapter = getBoardAdapter(canonical);
    assert.equal(getBoardAdapter(legacy), adapter);
    assert.equal(adapter.definition.name, canonical);
    assert.equal(adapter.createConfig().boardId, canonical);
    const original = { ...adapter.createConfig(), boardId: legacy, name: 'Existing project', port: 'COM7' };
    const result = parseConfig(original);
    assert.equal(result.boardId, canonical);
    assert.equal(result.name, original.name);
    assert.equal(result.port, original.port);
    assert.equal(original.boardId, legacy, 'loading does not rewrite the caller object');
  }
  assert.deepEqual(
    listBoards().map((board) => board.id),
    ['auto', 'Esp32_S3_CAM', 'STM32F103C8T6'],
  );
  for (const value of ['constructor', '__proto__', 'toString']) assert.equal(canonicalBoardId(value), value);
});

test('legacy platform compiler pins migrate in host parsing and in the descriptor editor', () => {
  const config = getBoardAdapter('stm32').createConfig();
  const build = {
    entry: 'src/main.c',
    cStandard: 'c99',
    settings: {
      mode: 'debug',
      optimizeForSize: false,
      platforms: {
        stm32: { c: { family: 'gnu-arm', version: '13.3.1-1.1' }, cpp: { family: 'inherit' } },
        'esp32-s3': { common: { family: 'arduino', version: '2.0.17' } },
      },
    },
  };
  const original = JSON.stringify(build);
  const migrated = parseProjectBuild(build);
  assert.equal(migrated.settings?.platforms?.STM32F103C8T6?.c?.version, '13.3.1-1.1');
  assert.equal(migrated.settings?.platforms?.Esp32_S3_CAM?.common?.version, '2.0.17');
  assert.equal(migrated.cStandard, 'c99');
  assert.equal(migrated.entry, 'src/main.c');
  assert.equal(JSON.stringify(build), original);
  const draft = readProjectSettings(JSON.stringify({ ...config, boardId: 'stm32', build }), config, {});
  assert.equal(draft.config.boardId, 'STM32F103C8T6');
  assert.deepEqual(draft.build, migrated);
  assert.deepEqual(parseProjectDescriptor(JSON.parse(writeProjectSettings(draft))).build, migrated);
});

test('canonical compiler overrides win dual-written keys while unrelated language pins survive', () => {
  const value = {
    settings: {
      platforms: {
        stm32: { c: { family: 'gnu-arm', version: '13.3.1' }, cpp: { family: 'auto' } },
        STM32F103C8T6: { c: { family: 'armclang', version: '6.22' } },
      },
    },
  };
  const merged = parseProjectBuild(value);
  assert.deepEqual(merged.settings?.platforms?.STM32F103C8T6, {
    c: { family: 'armclang', version: '6.22' },
    cpp: { family: 'auto' },
  });
  assert.deepEqual(migrateLegacyBuildPlatforms({ entry: 'main.c' }), { entry: 'main.c' });
});

test('profile recommendations do not cap explicit user allocations', () => {
  const adapter = getBoardAdapter('STM32F103C8T6');
  assert.deepEqual(adapter.definition.flashSizes, [64 * 1024]);
  assert.equal(adapter.definition.ramSize, 20 * 1024);
  const custom = { ...adapter.createConfigForFlash!(128 * 1024), flashSizeOverride: true };
  assert.equal(parseConfig(custom).flashSize, 128 * 1024);
  assert.equal(adapter.definition.probePatterns?.includes('STM32'), false);
  const esp = getBoardAdapter('Esp32_S3_CAM');
  assert.deepEqual(esp.definition.probePatterns, ['ESP32-S3']);
  assert.equal(esp.getFqbn(esp.createConfig()).split(':').slice(0, 3).join(':'), 'esp32:esp32:esp32s3');
});
