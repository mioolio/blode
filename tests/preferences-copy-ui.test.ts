import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Settings } from '../src/renderer/components/Settings';
import { getBoardAdapter } from '../extensions/registry';
import { translate } from '../src/renderer/i18n';

test('preferences keep installation guidance behind accessible help controls', () => {
  const html = renderToStaticMarkup(
    createElement(Settings, {
      config: getBoardAdapter('STM32F103C8T6').createConfig(),
      status: { arduinoCli: false, esp32Core: false, python: false, esptool: false, versions: {} },
      drivers: [],
      workspaceOpen: true,
      busy: false,
      isWeb: false,
      onChange() {},
      onSave() {},
      onInstallDriver() {},
      onRefreshDrivers() {},
    }),
  );
  assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
  assert.doesNotMatch(html, /UAC|项目、工具链|首次安装|系统未能自动匹配/);
  assert.match(html, /armclang/);
});

test('preferences manage toolchains locally and expose export in the renamed status section', () => {
  const html = renderToStaticMarkup(
    createElement(Settings, {
      config: getBoardAdapter('STM32F103C8T6').createConfig(),
      status: { arduinoCli: false, esp32Core: false, python: false, esptool: false, versions: {} },
      drivers: [],
      workspaceOpen: true,
      busy: false,
      isWeb: false,
      onChange() {},
      onSave() {},
      onInstallDriver() {},
      onRefreshDrivers() {},
    }),
  );
  assert.doesNotMatch(html, /data-preferences-section="devices"/);
  assert.ok(html.includes(translate('zh-CN', 'settings.toolchain')));
  assert.equal(translate('zh-CN', 'settings.status'), '工具链与导出');
  assert.equal(translate('zh-CN', 'settings.toolchain'), '编译与工具链');
  assert.doesNotMatch(html, /settings\.versions\.manageAction/);
});
