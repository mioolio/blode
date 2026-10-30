import test from 'node:test';
import assert from 'node:assert/strict';
import { anchoredImageZoom, fittedImageScale } from '../src/renderer/components/imageViewport';

test('fit scales a tall or wide image inside the viewport without enlarging small images', () => {
  assert.equal(fittedImageScale({ width: 640, height: 1600 }, { width: 800, height: 432 }), 0.25);
  assert.equal(fittedImageScale({ width: 1600, height: 640 }, { width: 432, height: 800 }), 0.25);
  assert.equal(fittedImageScale({ width: 64, height: 64 }, { width: 800, height: 600 }), 1);
});

test('zoom keeps the same image coordinate under the pointer after panning', () => {
  const pan = { x: 30, y: -15 },
    anchor = { x: 120, y: 80 };
  const next = anchoredImageZoom(0.5, 0.8, pan, anchor);
  assert.equal((anchor.x - next.pan.x) / next.scale, (anchor.x - pan.x) / 0.5);
  assert.equal((anchor.y - next.pan.y) / next.scale, (anchor.y - pan.y) / 0.5);
  const restored = anchoredImageZoom(next.scale, 0.5, next.pan, anchor);
  assert.ok(Math.abs(restored.pan.x - pan.x) < 1e-9);
  assert.ok(Math.abs(restored.pan.y - pan.y) < 1e-9);
});

test('zoom limits preserve the pointer anchor at the actual clamped scale', () => {
  const next = anchoredImageZoom(4, 40, { x: 0, y: 0 }, { x: 50, y: 20 });
  assert.equal(next.scale, 8);
  assert.deepEqual(next.pan, { x: -50, y: -20 });
  assert.equal(anchoredImageZoom(1, 0.0001, { x: 0, y: 0 }, { x: 0, y: 0 }).scale, 0.01);
});
