import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CollaborationPeer } from '../src/shared/collaboration';
import { peersForFile, peersForTool } from '../src/renderer/workspace/peerViews';
const peer = (id: string, values: Partial<CollaborationPeer> = {}): CollaborationPeer => ({
  userId: 'user',
  peerId: id,
  name: 'User',
  color: '#2563eb',
  path: 'main.c',
  openPaths: ['main.c', 'header.h'],
  startLine: 64,
  endLine: 84,
  editing: true,
  seenAt: '2026-10-29T00:00:00.000Z',
  ...values,
});
test('editing one file never marks all of that user open tabs as being edited', () => {
  const views = peersForFile([peer('one')], 'header.h');
  assert.equal(views.length, 1);
  assert.equal(views[0].editing, false);
  assert.equal(views[0].viewing, false);
  assert.equal(peersForFile([peer('one')], 'other.c').length, 0);
});
test('same-user browser windows have one avatar, preferring a real active editor', () => {
  const views = peersForFile(
    [
      peer('editor'),
      peer('viewer', { path: 'header.h', editing: false, seenAt: '2026-10-29T00:01:00.000Z' }),
    ],
    'main.c',
  );
  assert.equal(views.length, 1);
  assert.equal(views[0].peerId, 'editor');
  assert.equal(views[0].editing, true);
  const twoUsers = peersForFile([peer('one'), peer('two', { userId: 'other' })], 'main.c');
  assert.equal(twoUsers.length, 2);
});
test('tool avatars distinguish the active resource layout from background AI tabs', () => {
  const local = peer('desktop', {
    path: '',
    clientKind: 'desktop',
    openTools: ['layout', 'ai'],
    activeTool: 'layout',
    editing: false,
  });
  assert.equal(peersForTool([local], 'layout')[0].viewing, true);
  assert.equal(peersForTool([local], 'ai')[0].viewing, false);
  assert.equal(peersForFile([local], 'main.c')[0].viewing, false);
});
test('one user with several windows keeps one tool avatar, preferring its active window', () => {
  const viewers = [
    peer('one', { openTools: ['layout'], activeTool: 'layout' }),
    peer('two', { openTools: ['layout'], activeTool: 'ai' }),
  ];
  const views = peersForTool(viewers, 'layout');
  assert.equal(views.length, 1);
  assert.equal(views[0].peerId, 'one');
  assert.equal(views[0].editing, false);
});
