import test from 'node:test';
import assert from 'node:assert/strict';
import { getBoardAdapter } from '../extensions/registry';
import { parseProjectDescriptor } from '../src/core/config';
import { readProjectSettings, writeProjectSettings } from '../src/renderer/workspace/projectSettings';

test('advanced settings preserve tool paths and explicit files while changing the C standard and entry', () => {
  const config = getBoardAdapter('stm32').createConfig();
  config.toolchain.armCompilerDirectory = 'C:/tools/compiler';
  const draft = readProjectSettings(
    JSON.stringify({ ...config, build: { sketch: 'old.c', files: ['old.c'] } }),
    config,
    {},
  );
  draft.entry = 'src/main.c';
  draft.files = 'src/main.c\nstart.s\nsrc/main.c';
  draft.cStandard = 'c99';
  const saved = parseProjectDescriptor(JSON.parse(writeProjectSettings(draft)));
  assert.deepEqual(saved.build, { entry: 'src/main.c', files: ['src/main.c', 'start.s'], cStandard: 'c99' });
  assert.equal(saved.config.toolchain.armCompilerDirectory, 'C:/tools/compiler');
  draft.entry = '';
  draft.files = '';
  assert.deepEqual(parseProjectDescriptor(JSON.parse(writeProjectSettings(draft))).build, {
    cStandard: 'c99',
  });
});

test('advanced settings reject malformed descriptors and do not overwrite their text', () => {
  const config = getBoardAdapter('stm32').createConfig();
  for (const text of ['{', '{}', '[]', JSON.stringify({ ...config, build: { files: 'main.c' } })])
    assert.throws(() => readProjectSettings(text, config, {}));
});

test('advanced and compile settings preserve each other across a descriptor round trip', () => {
  const config = getBoardAdapter('stm32').createConfig();
  const settings = {
    mode: 'debug' as const,
    optimizeForSize: false,
    common: { family: 'auto' as const },
    platforms: {
      stm32: {
        c: { family: 'gnu-arm' as const, version: '13.3.1-1.1' },
        cpp: { family: 'gnu-arm' as const, version: '14.2.1-1.1' },
      },
      'esp32-s3': { common: { family: 'arduino' as const, version: '2.0.17' } },
    },
  };
  const draft = readProjectSettings(
    JSON.stringify({
      ...config,
      build: { entry: 'src/main.c', files: ['src/main.c', 'start.s'], cStandard: 'c99', settings },
    }),
    config,
    {},
  );
  draft.config.name = 'Updated project';
  const result = parseProjectDescriptor(JSON.parse(writeProjectSettings(draft)));
  assert.equal(result.config.name, 'Updated project');
  assert.equal(result.build.entry, 'src/main.c');
  assert.deepEqual(result.build.files, ['src/main.c', 'start.s']);
  assert.equal(result.build.cStandard, 'c99');
  assert.deepEqual(result.build.settings, settings);
});
