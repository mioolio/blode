import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipPeerRange, peerRangeMotion } from '../src/renderer/editor/peerRangeGeometry';

test('reader bands clip to the local editor instead of painting over headers or the console', () => {
  assert.deepEqual(clipPeerRange(10, 150, 40, 80), { top: 0, height: 80, documentTop: 10 });
  assert.deepEqual(clipPeerRange(85, 200, 40, 80), { top: 45, height: 35, documentTop: 85 });
  assert.equal(clipPeerRange(200, 250, 40, 80), null);
  assert.equal(clipPeerRange(0, 40, 40, 80), null);
});
test('folded or invalid geometry cannot leave an inverted or unbounded colored rectangle', () => {
  for (const bounds of [
    [0, 0, 0, 80],
    [100, 90, 0, 80],
    [0, 1, 0, 0],
    [NaN, 90, 0, 80],
    [0, Infinity, 0, 80],
  ])
    assert.equal(clipPeerRange(...(bounds as [number, number, number, number])), null);
});
test('nearby peer motion eases, distant jumps crossfade, and local scroll stays exact', () => {
  const before = clipPeerRange(50, 100, 0, 300)!;
  const near = clipPeerRange(80, 200, 0, 300)!;
  const distant = clipPeerRange(1000, 1100, 900, 300)!;
  assert.equal(peerRangeMotion(before, near, 300, true, false), 'move');
  assert.equal(peerRangeMotion(before, distant, 300, true, false), 'crossfade');
  assert.equal(peerRangeMotion(before, near, 300, false, false), 'immediate');
  assert.equal(peerRangeMotion(before, near, 300, true, true), 'immediate');
  assert.equal(peerRangeMotion(undefined, near, 300, true, false), 'immediate');
});
