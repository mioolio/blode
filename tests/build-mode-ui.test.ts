import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBoardAdapter } from '../extensions/registry';
import type { AppState, ProjectConfig, ToolchainStatus } from '../src/shared/contracts';
import { MemoryUsage } from '../src/renderer/components/MemoryUsage';
import { Settings } from '../src/renderer/components/Settings';
import { StudioDialogs } from '../src/renderer/components/StudioDialogs';
import { translate } from '../src/renderer/i18n';
import { validatesExistingFirmware } from '../src/renderer/workspace/buildMode';
import type { Studio } from '../src/renderer/workspace/useStudio';

test('a platform supporting source and binary builds validates only when no source entry is selected', () => {
  const platform = { capabilities: ['compile', 'flash', 'validate-firmware'] };
  assert.equal(validatesExistingFirmware(platform, {}), true);
  assert.equal(validatesExistingFirmware(platform, { entry: 'src/main.c' }), false);
  assert.equal(validatesExistingFirmware(platform, { entry: '.' }), false);
  assert.equal(validatesExistingFirmware(platform, { sketch: 'src' }), false);
  // Arduino projects retain their conventional root sketch without an explicit entry.
  assert.equal(validatesExistingFirmware({ capabilities: ['compile', 'flash'] }, {}), false);
  assert.equal(validatesExistingFirmware({ capabilities: ['probe'] }, {}), false);
});

test('memory and flash confirmation distinguish compiled STM32 source from a validated binary', () => {
  const adapter = getBoardAdapter('STM32F103C8T6');
  const config = adapter.createConfig();
  const platform = { ...adapter.definition, capabilities: ['compile', 'flash', 'validate-firmware'] };
  const state: AppState = {
    projectRoot: '/project',
    workspaceOpen: true,
    config,
    build: { entry: 'src/main.c' },
    files: [],
    boards: [platform],
    debugProbes: [],
    inventory: { entries: [], totalBytes: 0, fileCount: 0, directoryCount: 0, truncated: false },
    ports: [],
    detection: { candidates: [], unavailablePlatforms: [] },
    drivers: [],
    toolchain: { arduinoCli: false, esp32Core: false, python: false, esptool: false, versions: {} },
    pipe: { endpoint: '', tokenFile: '' },
    web: { endpoint: '', tokenFile: '', allowExternal: false },
    buildStale: false,
    lastBuild: {
      success: true,
      flashUsed: 1024,
      flashTotal: 65536,
      ramUsed: 0,
      ramTotal: 0,
      artifacts: ['firmware.bin'],
      timestamp: '',
      output: 'ok',
    },
  };
  const memoryLabel = () =>
    renderToStaticMarkup(createElement(MemoryUsage, { state, config, drafts: {}, stale: false })).match(
      /class="measurement-state">([^<]*)<\//,
    )?.[1];
  assert.equal(memoryLabel(), translate('zh-CN', 'memory.compiled'));
  state.build = {};
  assert.equal(memoryLabel(), translate('zh-CN', 'memory.validated'));

  const studio = {
    config,
    board: platform,
    t: (key: string) => key,
    confirmFlash: true,
    isStm32: true,
    usesStlink: true,
    validatesFirmware: false,
    busy: '',
  } as Studio;
  const compiledDialog = renderToStaticMarkup(createElement(StudioDialogs, { studio }));
  assert.match(compiledDialog, /dialog\.stm32CompiledFlashBody/);
  studio.validatesFirmware = true;
  const binaryDialog = renderToStaticMarkup(createElement(StudioDialogs, { studio }));
  assert.match(binaryDialog, /dialog\.stm32FlashBody/);

  studio.config = {
    ...config,
    partitions: [{ ...config.partitions[0]!, size: 1024 }],
  };
  studio.state = {
    lastBuild: { ...state.lastBuild!, flashUsed: 2048 },
  } as AppState;
  const warnedDialog = renderToStaticMarkup(createElement(StudioDialogs, { studio }));
  assert.match(warnedDialog, /dialog\.resourceWarning/);
  assert.match(warnedDialog, /dialog\.confirmFlash/);
});

function settings(config: ProjectConfig): string {
  const status: ToolchainStatus = {
    arduinoCli: false,
    esp32Core: false,
    python: false,
    esptool: false,
    stlink: true,
    armCompiler: true,
    versions: { armCompiler: 'Arm Compiler 6.24' },
  };
  config.toolchain.armCompilerDirectory = 'C:\\tools\\armclang\\bin';
  return renderToStaticMarkup(
    createElement(Settings, {
      config,
      status,
      drivers: [],
      workspaceOpen: true,
      onChange: () => {},
      onSave: () => {},
      onInstall: () => {},
      onInstallDriver: () => {},
      onRefreshDrivers: () => {},
      busy: false,
      isWeb: false,
    }),
  );
}

test('automatic and STM32 preferences expose the Arm Compiler path and actual detected version', () => {
  for (const platform of ['auto', 'STM32F103C8T6']) {
    const html = settings(getBoardAdapter(platform).createConfig());
    assert.ok(html.includes('value="C:\\tools\\armclang\\bin"'));
    assert.match(html, /Arm Compiler 6\.24/);
  }
  const esp = settings(getBoardAdapter('Esp32_S3_CAM').createConfig());
  assert.doesNotMatch(esp, /Arm Compiler 6\.24/);
  assert.ok(!esp.includes('value="C:\\tools\\armclang\\bin"'));
});
