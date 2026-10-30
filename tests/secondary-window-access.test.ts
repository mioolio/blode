import test from 'node:test';
import assert from 'node:assert/strict';
import { packageWindowMethodAllowed as allowed } from '../src/core/secondary-window-access';
test('extension windows cannot act as the workspace renderer or another extension', () => {
  const owner = { kind: 'extension' as const, pluginId: 'Personalization' };
  assert.equal(allowed(owner, 'windowAction', ['close']), true);
  for (const method of [
    'generalExtensionContext',
    'generalExtensionConfigure',
    'generalExtensionViewDocument',
    'generalExtensionViewUrl',
    'generalExtensionOpenView',
  ]) {
    assert.equal(allowed(owner, method, [{ id: 'Personalization' }]), true);
    assert.equal(allowed(owner, method, [{ id: 'Other' }]), false);
  }
  for (const method of [
    'modelServiceState',
    'modelServiceConfigure',
    'aiChatStart',
    'generalExtensionEnable',
    'generalExtensionState',
    'runtimePluginsState',
    'saveFile',
    'build',
    'terminalRun',
  ])
    assert.equal(allowed(owner, method, [{ id: 'Personalization' }]), false);
  assert.equal(allowed({ kind: 'runtime', pluginId: 'board' }, 'runtimePluginContext', ['board']), true);
  assert.equal(
    allowed({ kind: 'runtime', pluginId: 'board' }, 'generalExtensionContext', [{ id: 'board' }]),
    false,
  );
});
