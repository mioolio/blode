import test from 'node:test';
import assert from 'node:assert/strict';
import { UiCommands, uiCommandSchema } from '../src/core/ui-commands';
import type { UiRequest } from '../src/shared/workbench';
import { registeredRuntimeViews } from '../src/shared/runtime-views';
import type { RuntimePluginInfo } from '../src/shared/plugins';

test('runtime view commands require bounded identifiers and target exactly one client', async () => {
  for (const value of [
    { action: 'runtimeView' },
    { action: 'runtimeView', pluginId: 'Fixture' },
    { action: 'runtimeView', pluginId: '../Fixture', viewId: 'inspect' },
    { action: 'runtimeView', pluginId: 'Fixture', viewId: 'inspect', script: 'alert(1)' },
  ])
    assert.equal(uiCommandSchema.safeParse(value).success, false);
  let sent: UiRequest | undefined;
  const broker = new UiCommands((request) => {
    sent = request;
  });
  try {
    for (const clientId of ['web:one', 'web:two'])
      broker.publishState({
        clientId,
        browser: true,
        projectRoot: '',
        activePath: '',
        openFiles: [],
        view: 'code',
        home: true,
        dirtyFiles: [],
        busy: '',
        consolePanelVisible: true,
        devicePanelVisible: true,
      });
    const result = broker.command({
      action: 'runtimeView',
      pluginId: 'Fixture',
      viewId: 'inspect',
      target: 'web:two',
    });
    assert.equal(sent?.target, 'web:two');
    assert.equal(sent?.pluginId, 'Fixture');
    broker.reply({ id: sent!.id, clientId: 'web:one', error: 'wrong client' });
    broker.reply({ id: sent!.id, clientId: 'web:two' });
    assert.deepEqual(await result, { applied: true, target: 'web:two' });
  } finally {
    broker.dispose();
  }
});

test('view registry removes every surface of unapproved or restart-required packages', () => {
  const fixture = (id: string, trust: RuntimePluginInfo['trust'], restartRequired = false) =>
    ({
      id,
      trust,
      restartRequired,
      manifest: {
        ui: { views: [{ id: 'inspect', label: 'Inspect', file: 'device.html', location: 'panel' }] },
      },
    }) as RuntimePluginInfo;
  const state = registeredRuntimeViews([
    fixture('Allowed', 'session'),
    fixture('Revoked', 'required'),
    fixture('Changed', 'permanent', true),
  ]);
  assert.deepEqual(
    state.map((view) => view.key),
    ['plugin:Allowed/inspect'],
  );
});
