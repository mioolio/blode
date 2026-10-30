import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBoardAdapter } from '../extensions/registry';
import type { RuntimePluginManifest } from '../src/shared/plugins';
import { RuntimeDeviceFields } from '../src/renderer/components/RuntimeDeviceFields';

test('USB runtime fields expose the physical selector and declared controls without requiring COM ports', () => {
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  config.runtime = {
    deviceId: 'vid_1234:pid_5678',
    values: { channel: 'B', verify: true },
    disabledCapabilities: ['layout'],
  };
  const plugin: RuntimePluginManifest = {
    id: 'custom_usb',
    name: 'USB target',
    version: '1.0.0',
    apiVersion: 2,
    runtimeApiVersion: 2,
    kind: 'board',
    runtime: 'runtime.mjs',
    transport: 'usb',
    capabilities: ['flash', 'layout', 'serial'],
    defaultConfig: config,
    support: { chips: ['TestChip'], status: 'experimental' },
    compiler: { mode: 'host', baseRuntime: 'STM32F103C8T6' },
    debugger: { mode: 'none' },
    layout: { recommendedFlashSizes: [65536], ramSize: 20480 },
    constraints: {},
    ui: {
      fields: [
        {
          id: 'channel',
          label: 'USB channel',
          type: 'select',
          options: [
            { value: 'A', label: 'A' },
            { value: 'B', label: 'B' },
          ],
        },
        { id: 'verify', label: 'Verify <firmware>', type: 'boolean' },
      ],
      hiddenCapabilities: ['serial'],
    },
  };
  const html = renderToStaticMarkup(
    createElement(RuntimeDeviceFields, { plugin, config, disabled: false, onChange() {} }),
  );
  assert.match(html, /vid_1234:pid_5678/);
  assert.match(html, /USB channel/);
  assert.match(html, /<option value="B" selected="">/);
  assert.match(html, /Verify &lt;firmware&gt;/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.doesNotMatch(html, /COM\d|<firmware>/);
});
