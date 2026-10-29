import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBoardAdapter, listBoards } from '../extensions/registry';
import type { AppState, ProjectBuildInputs } from '../src/shared/contracts';
import BuildSettingsDialog from '../src/renderer/components/BuildSettingsDialog';
import { BuildSettingsLauncher } from '../src/renderer/components/BuildSettingsLauncher';
import { ToolVersionSettings } from '../src/renderer/components/ToolVersionSettings';
import { translate } from '../src/renderer/i18n';
import type { Studio } from '../src/renderer/workspace/useStudio';
import type { RuntimePluginManifest } from '../src/shared/plugins';

function studioFor(build: ProjectBuildInputs = {}, content?: string): Studio {
  const config = getBoardAdapter('auto').createConfig();
  const state: AppState = {
    config,
    build,
    projectRoot: '/project',
    workspaceOpen: true,
    files: [{ path: 'be', content: content ?? JSON.stringify({ ...config, build }), language: 'json' }],
    boards: listBoards(),
    ports: [],
    debugProbes: [],
    detection: { candidates: [], unavailablePlatforms: [] },
    drivers: [],
    toolchain: { arduinoCli: false, esp32Core: false, python: false, esptool: false, versions: {} },
    inventory: { entries: [], totalBytes: 0, fileCount: 0, directoryCount: 0, truncated: false },
    pipe: { endpoint: '', tokenFile: '' },
    web: { endpoint: '', tokenFile: '', allowExternal: false },
    buildStale: false,
    lastBuild: null,
  };
  return {
    t: (key: string) => key,
    state,
    config,
    drafts: {},
    configDirty: false,
    busy: '',
  } as Studio;
}

function render(studio: Studio): string {
  return renderToStaticMarkup(createElement(BuildSettingsDialog, { studio, onClose() {} }));
}

test('compiler settings render without a connected board and default to release with size optimization', () => {
  const html = render(studioFor({ entry: 'User/main.c' }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /<option value="release" selected="">/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.match(html, /<option value="inherit" selected="">buildSettings.followProject/);
  assert.match(html, />STM32F103C8T6<\/button>/);
  assert.match(html, />Esp32_S3_CAM<\/button>/);
  assert.match(html, /role="combobox"/);
  assert.doesNotMatch(html, /buildSettings.installHint/);
  assert.doesNotMatch(html, /role="alert"/);
});

test('custom Arduino settings expose CLI and package-store paths while keeping core directory out of compiler inputs', () => {
  const html = render(
    studioFor({
      entry: 'src',
      settings: {
        mode: 'debug',
        common: {
          family: 'arduino',
          version: '3.3.7',
          arduinoCli: '/tools/cli/bin/arduino-cli',
          packageDirectory: '/tools/esp32-store',
          directory: '/tools/esp32-store/arduino-data/packages/esp32/hardware/esp32/3.3.7',
        },
      },
    }),
  );
  assert.match(html, /<option value="debug" selected="">/);
  assert.match(html, /type="checkbox" disabled=""/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /value="\/tools\/cli\/bin\/arduino-cli"/);
  assert.match(html, /value="\/tools\/esp32-store"/);
  assert.match(html, /value="3\.3\.7"/);
  assert.doesNotMatch(html, /value="[^\"]*arduino-data/);
});

test('invalid project descriptors show an error and disable save instead of opening a writable form', () => {
  const html = render(studioFor({}, '{ broken'));
  assert.match(html, /role="alert">error.invalidProjectDescriptor/);
  assert.match(html, /<button class="primary" disabled="">action.save<\/button>/);
  assert.doesNotMatch(html, /class="build-settings-body"/);
});

test('third-party compiler selection remains explicit and its override permission is restored from the project', () => {
  const build: ProjectBuildInputs = {
    settings: { common: { family: 'plugin', pluginId: 'USB_ThirdParty' } },
  };
  const studio = studioFor(build);
  const config = {
    ...getBoardAdapter('STM32F103C8T6').createConfig(),
    boardId: 'USB_ThirdParty',
    runtime: { forceCompiler: false },
  };
  const plugin: RuntimePluginManifest = {
    id: config.boardId,
    name: 'USB Third Party',
    version: '1.0.0',
    apiVersion: 2,
    runtimeApiVersion: 2,
    kind: 'board',
    runtime: 'runtime.mjs',
    transport: 'usb',
    capabilities: ['compile'],
    defaultConfig: config,
    support: { chips: ['CustomChip'], status: 'experimental' },
    compiler: {
      mode: 'plugin',
      baseRuntime: 'STM32F103C8T6',
      forceComponent: true,
      defaultTool: { id: 'custom-cc', executable: 'tools/compiler.mjs', runner: 'node', version: '1.2.0' },
    },
    debugger: { mode: 'none' },
    layout: { recommendedFlashSizes: [65536], ramSize: 20480 },
    constraints: {},
    ui: { fields: [] },
  };
  studio.config = config;
  studio.state!.config = config;
  studio.state!.boards.push({
    ...getBoardAdapter('STM32F103C8T6').definition,
    id: plugin.id,
    name: plugin.name,
    defaultConfig: config,
    runtimePlugin: plugin,
  });
  studio.state!.files[0].content = JSON.stringify({ ...config, build });
  const html = render(studio);
  assert.match(html, />USB Third Party<\/button>/);
  assert.match(html, /<option value="plugin:USB_ThirdParty" selected="">/);
  assert.match(html, /tools\/compiler\.mjs/);
  assert.match(html, /type="checkbox"\/>buildSettings.forceCompiler/);
  assert.doesNotMatch(html, /class="build-custom-tool"/);
  config.runtime.forceCompiler = true;
  studio.state!.files[0].content = JSON.stringify({ ...config, build });
  assert.match(render(studio), /type="checkbox" checked=""\/>buildSettings.forceCompiler/);
});

test('closed launcher and tool preferences server-render without requiring a desktop bridge', () => {
  const studio = studioFor();
  assert.equal(renderToStaticMarkup(createElement(BuildSettingsLauncher, { studio })), '');
  studio.state!.workspaceOpen = false;
  assert.equal(renderToStaticMarkup(createElement(BuildSettingsLauncher, { studio })), '');
  const html = renderToStaticMarkup(
    createElement(ToolVersionSettings, {
      config: studio.config!,
      onChange() {},
      busy: false,
      workspaceOpen: false,
    }),
  );
  assert.ok(html.includes(translate('zh-CN', 'settings.versions.restart')));
});

test('forced build backend restores a selected or unavailable runtime without discarding it', () => {
  const studio = studioFor();
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  config.runtime = { forceCompiler: true, compilerRuntime: 'Esp32_S3_CAM' };
  studio.config = config;
  studio.state!.config = config;
  studio.state!.files[0].content = JSON.stringify({ ...config, build: {} });
  const html = render(studio);
  assert.match(html, /buildSettings.forceBackend/);
  assert.match(html, /<option value="Esp32_S3_CAM" selected="">/);
  assert.match(html, /<option value="">buildSettings.followRuntime/);
  config.runtime.compilerRuntime = 'Absent_Backend';
  studio.state!.files[0].content = JSON.stringify({ ...config, build: {} });
  assert.match(render(studio), /<option value="Absent_Backend" selected="">Absent_Backend/);
  config.runtime.forceCompiler = false;
  studio.state!.files[0].content = JSON.stringify({ ...config, build: {} });
  assert.doesNotMatch(render(studio), /buildSettings.forceBackend/);
});
