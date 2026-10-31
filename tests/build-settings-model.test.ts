import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompilerChoice,
  updateBuildCompilerChoice,
} from '../src/renderer/components/buildSettingsModel';
import type { BuildSettings } from '../src/shared/build-settings';
import { compilerChoice as stmCompilerChoice } from '../extensions/boards/STM32F103C8T6/compiler/build-settings';

test('one compiler form reads legacy global and platform defaults without changing untouched selections', () => {
  const settings: BuildSettings = {
    common: { family: 'gnu-arm', version: '13.3' },
    platforms: {
      STM32F103C8T6: {
        common: { family: 'armclang', version: '6.22' },
        c: { family: 'gnu-arm', version: '14.2' },
      },
      Esp32_S3_CAM: { common: { family: 'arduino', version: '3.0.7' } },
    },
  };
  assert.equal(buildCompilerChoice(settings, 'STM32F103C8T6', 'common')?.version, '6.22');
  assert.equal(buildCompilerChoice(settings, 'STM32F103C8T6', 'c')?.version, '14.2');
  const next = updateBuildCompilerChoice(settings, 'STM32F103C8T6', 'common', {
    family: 'gnu-arm',
    version: '15.2',
  });
  assert.deepEqual(stmCompilerChoice(next, 'cpp'), { family: 'gnu-arm', version: '15.2' });
  assert.deepEqual(stmCompilerChoice(next, 'c'), { family: 'gnu-arm', version: '14.2' });
  assert.deepEqual(next.common, settings.common);
  assert.deepEqual(next.platforms?.Esp32_S3_CAM, settings.platforms?.Esp32_S3_CAM);
  assert.equal(settings.platforms?.STM32F103C8T6?.common?.version, '6.22');
  const following = updateBuildCompilerChoice(next, 'STM32F103C8T6', 'common', { family: 'inherit' });
  assert.deepEqual(stmCompilerChoice(following, 'cpp'), settings.common);
});

test('automatic configuration edits only the workspace compiler and preserves platform overrides', () => {
  const settings: BuildSettings = { platforms: { STM32F103C8T6: { common: { family: 'armclang' } } } };
  const next = updateBuildCompilerChoice(settings, 'auto', 'common', { family: 'auto' });
  assert.deepEqual(next.common, { family: 'auto' });
  assert.deepEqual(next.platforms, settings.platforms);
  assert.deepEqual(buildCompilerChoice(next, undefined, 'common'), { family: 'auto' });
  assert.deepEqual(stmCompilerChoice(next, 'cpp'), { family: 'armclang' });
});
