import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, EventBuffer, routeSchemas } from '../src/automation/routes';
import type { CoreApi } from '../src/shared/contracts';
import { UiCommands } from '../src/core/ui-commands';
import type { UiRequest, UiState } from '../src/shared/workbench';
import { toJSONSchema } from 'zod';

test('every automation input schema can be exported to the MCP tool catalog', () => {
  for (const [name, schema] of Object.entries(routeSchemas))
    assert.doesNotThrow(() => JSON.stringify(toJSONSchema(schema, { io: 'input' })), name);
});

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

test('interactive terminal automation requires explicit execution consent and preserves cursor parameters', async () => {
  const calls: { method: string; params: unknown }[] = [];
  const api = {
    automationInvoke: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return null;
    },
  } as unknown as CoreApi;
  for (const method of ['terminal.open', 'terminal.write', 'terminal.run', 'terminal.close'])
    await assert.rejects(() => dispatch(api, new EventBuffer(), method, {}));
  await assert.rejects(() =>
    dispatch(api, new EventBuffer(), 'terminal.write', { data: 'yes\r', confirm: false }),
  );
  await assert.rejects(() => dispatch(api, new EventBuffer(), 'terminal.resize', { cols: 0, rows: 20 }));
  assert.equal(calls.length, 0);
  const requests = [
    { method: 'terminal.state', params: { sessionId: 'current', after: 42 } },
    { method: 'terminal.open', params: { cols: 100, rows: 30, confirm: true } },
    { method: 'terminal.write', params: { sessionId: 'current', data: 'yes\r', confirm: true } },
    { method: 'terminal.resize', params: { sessionId: 'current', cols: 120, rows: 40 } },
    { method: 'terminal.close', params: { confirm: true } },
  ];
  for (const { method, params } of requests) await dispatch(api, new EventBuffer(), method, params);
  assert.deepEqual(calls, requests);
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
