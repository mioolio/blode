import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleFilePaths, reconcileDismissedTabs } from '../src/renderer/workspace/remoteTabs';

test('closing a shared tab hides it locally while the other user still reads it', () => {
  const remote = ['main.c', 'header.h'];
  assert.deepEqual(visibleFilePaths(['main.c'], remote, new Set()), ['main.c', 'header.h']);
  const dismissed = new Set(['main.c']);
  const reconciled = reconcileDismissedTabs(dismissed, [], remote);
  assert.equal(reconciled, dismissed);
  assert.deepEqual(visibleFilePaths([], remote, reconciled), ['header.h']);
  assert.deepEqual(remote, ['main.c', 'header.h']);
});
test('dismissed suggestions can be explicitly reopened or return after a new remote opening', () => {
  const dismissed = new Set(['main.c']);
  assert.equal(reconcileDismissedTabs(dismissed, ['main.c'], ['main.c']).size, 0);
  const closedEpisode = reconcileDismissedTabs(dismissed, [], []);
  assert.equal(closedEpisode.size, 0);
  assert.deepEqual(visibleFilePaths([], ['main.c'], closedEpisode), ['main.c']);
});
test('hundreds of remote suggestions remain deduplicated and never mutate local ownership', () => {
  const local = ['local.c'];
  const remote = Array.from({ length: 400 }, (_, index) => `file-${index}.c`);
  const dismissed = new Set(remote.slice(0, 350));
  const tabs = visibleFilePaths(local, [...remote, ...remote], dismissed);
  assert.equal(tabs.length, 51);
  assert.deepEqual(local, ['local.c']);
  assert.equal(reconcileDismissedTabs(dismissed, local, remote), dismissed);
});
