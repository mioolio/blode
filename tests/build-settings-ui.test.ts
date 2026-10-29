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
  assert.match(html, />STM32<\/button>/);
  assert.match(html, />ESP32-S3<\/button>/);
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
