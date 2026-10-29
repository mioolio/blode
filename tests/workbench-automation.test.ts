import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, EventBuffer, routeSchemas } from '../src/automation/routes';
import type { CoreApi } from '../src/shared/contracts';
import { UiCommands } from '../src/core/ui-commands';
import type { UiRequest, UiState } from '../src/shared/workbench';

test('extended automation rejects missing confirmation and invalid parameters before dispatch', async () => {
  const calls: string[] = [];
  const api = {
    automationInvoke: async (method: string) => {
      calls.push(method);
      return { ok: true };
    },
  } as unknown as CoreApi;
  for (const method of [
    'file.delete',
    'drivers.install',
    'project.close',
    'firmware.flash',
    'debugger.tools.install',
    'window.action',
  ]) {
    await assert.rejects(() => dispatch(api, new EventBuffer(), method, {}));
  }
  assert.deepEqual(calls, []);
  await dispatch(api, new EventBuffer(), 'file.create', { path: 'src/main.c' });
  assert.deepEqual(calls, ['file.create']);
  assert.ok(Object.hasOwn(routeSchemas, 'ai.prediction.submit'));
  assert.ok(Object.hasOwn(routeSchemas, 'collaboration.edit'));
  await assert.rejects(() =>
    dispatch(api, new EventBuffer(), 'debugger.memory', { address: -1, length: 9000 }),
  );
  await assert.rejects(() =>
    dispatch(api, new EventBuffer(), 'ui.command', { action: 'eval', code: 'bad()' }),
  );
  assert.deepEqual(calls, ['file.create']);
});

test('UI automation is targeted and only the correct renderer can acknowledge it', async () => {
  let request: UiRequest | undefined;
  const broker = new UiCommands((value) => {
    request = value;
  });
  const state: UiState = {
    clientId: 'desktop',
    browser: false,
    projectRoot: '/project',
    activePath: 'main.c',
    openFiles: ['main.c'],
    view: 'code',
    home: false,
    dirtyFiles: [],
    busy: '',
    consolePanelVisible: true,
    devicePanelVisible: true,
  };
  broker.publishState(state);
  const operation = broker.command({ action: 'consolePanel', visible: false });
  assert.equal(request?.target, 'desktop');
  broker.reply({ id: request!.id, clientId: 'web:other' });
  broker.reply({ id: request!.id, clientId: 'desktop' });
  assert.deepEqual(await operation, { applied: true, target: 'desktop' });
  await assert.rejects(() => broker.command({ action: 'home', target: 'missing' }), /uiUnavailable/);
  broker.dispose();
});
