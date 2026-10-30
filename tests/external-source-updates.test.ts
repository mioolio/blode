import test from 'node:test';
import assert from 'node:assert/strict';
import type { LanguageExternalSource } from '../src/shared/language';
import { externalSourceUpdate } from '../src/renderer/workspace/externalSourceUpdates';

const source: LanguageExternalSource = {
  id: 'a'.repeat(32),
  path: `@external/${'a'.repeat(32)}/esp_log.h`,
  name: 'esp_log.h',
  displayPath: '/sdk/include/esp_log.h',
  content: '#define ESP_LOGI(...) old(__VA_ARGS__)\n',
  language: 'cpp',
  readonly: true,
};

test('refreshed external text updates open tabs without duplicating equal snapshots', () => {
  const previous = { [source.path]: source };
  assert.equal(externalSourceUpdate(previous, '/project', { root: '/project', source }), previous);
  const nextSource = { ...source, content: '\n#define ESP_LOGI(...) new(__VA_ARGS__)\n' };
  const updated = externalSourceUpdate(previous, '/project', { root: '/project', source: nextSource });
  assert.equal(updated[source.path].content, nextSource.content);
  assert.equal(updated[source.path].readonly, true);
  assert.equal(previous[source.path].content, source.content);
});

test('late workspace updates and writable or malformed source events leave current tabs intact', () => {
  const files = { [source.path]: source };
  for (const detail of [
    undefined,
    { root: '/old-project', source },
    { root: '/project', source: { ...source, readonly: false } },
    { root: '/project', source: { ...source, path: 'main.c' } },
    { root: '/project', source: { ...source, content: undefined } },
  ])
    assert.equal(externalSourceUpdate(files, '/project', detail), files);
  assert.equal(externalSourceUpdate(files, '', { root: '', source }), files);
});
