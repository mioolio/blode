import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasUnsavedChanges,
  saveBeforeAppClose,
  refreshedConfig,
  type UnsavedSnapshot,
} from '../src/renderer/workspace/unsavedChanges';
import { getBoardAdapter } from '../extensions/registry';
import type { AppState } from '../src/shared/contracts';

function snapshot(): UnsavedSnapshot {
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  return {
    state: {
      workspaceOpen: true,
      projectRoot: 'project',
      config: structuredClone(config),
      files: [{ path: 'main.c', language: 'c', content: 'int main() {}' }],
    },
    config,
    drafts: {},
  };
}

test('only changed contents or project configuration require a close decision', () => {
  const owner = snapshot();
  assert.equal(hasUnsavedChanges(owner), false);
  owner.drafts['main.c'] = 'int main() {}';
  assert.equal(hasUnsavedChanges(owner), false);
  owner.config!.name = 'edited config';
  assert.equal(hasUnsavedChanges(owner), true);
  owner.config = structuredClone(owner.state!.config);
  owner.drafts['main.c'] = 'int main() { return 1; }';
  assert.equal(hasUnsavedChanges(owner), true);
  owner.state!.workspaceOpen = false;
  assert.equal(hasUnsavedChanges(owner), false);
});

test('unsuccessful save never produces permission to close', async () => {
  const owner = snapshot();
  owner.drafts['main.c'] = 'changed';
  let read = 0;
  assert.equal(
    await saveBeforeAppClose(
      () => owner,
      async () => false,
      async () => {
        read++;
        return owner.state as AppState;
      },
    ),
    'failed',
  );
  assert.equal(read, 0);
  assert.equal(owner.drafts['main.c'], 'changed');
});

test('new edits or a workspace switch during save require another decision', async () => {
  const owner = snapshot();
  owner.drafts['main.c'] = 'first';
  assert.equal(
    await saveBeforeAppClose(
      () => owner,
      async () => {
        owner.state!.files[0].content = 'first';
        owner.drafts['main.c'] = 'second';
        return true;
      },
      async () => owner.state as AppState,
    ),
    'changed',
  );
  const canonical = structuredClone(owner.state!);
  canonical.projectRoot = 'another project';
  assert.equal(hasUnsavedChanges(owner, canonical), true);
});

test('canonical comparison permits stale render draft flags only when bytes are already saved', async () => {
  const owner = snapshot();
  owner.drafts['main.c'] = 'changed';
  const canonical = structuredClone(owner.state!);
  canonical.files[0].content = 'changed';
  assert.equal(
    await saveBeforeAppClose(
      () => owner,
      async () => true,
      async () => canonical as AppState,
    ),
    'saved',
  );
});

test('background refresh and an older save acknowledgement preserve an unsaved configuration', () => {
  const owner = snapshot();
  const pending = { ...owner.config!, name: 'local pending' };
  const acknowledged = { ...owner.config!, name: 'submitted before the new edit' };
  const canonical = { ...owner.state!, config: acknowledged };
  assert.equal(refreshedConfig(pending, owner.state, canonical), pending);
  assert.equal(refreshedConfig(pending, owner.state, canonical, acknowledged), pending);
  assert.equal(hasUnsavedChanges({ ...owner, config: pending }, canonical), true);
});

test('a matching saved configuration or a different workspace adopts its current canonical configuration', () => {
  const owner = snapshot();
  const submitted = { ...owner.config!, name: 'saved' };
  const canonical = { ...owner.state!, config: structuredClone(submitted) };
  assert.equal(refreshedConfig(submitted, owner.state, canonical, submitted), canonical.config);
  assert.equal(
    refreshedConfig(submitted, owner.state, { ...canonical, projectRoot: 'different' }),
    canonical.config,
  );
});
