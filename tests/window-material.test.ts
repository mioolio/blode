import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWindowMaterial } from '../src/core/window-material';

test('desktop material is only requested on Windows 11 22H2 and newer', () => {
  assert.equal(nativeWindowMaterial('win32', '10.0.22621'), 'acrylic');
  assert.equal(nativeWindowMaterial('win32', '10.0.26200'), 'acrylic');
  assert.equal(nativeWindowMaterial('win32', '10.0.19045'), undefined);
  assert.equal(nativeWindowMaterial('win32', '10.0.2262'), undefined);
  assert.equal(nativeWindowMaterial('darwin', '24.0.0'), undefined);
  assert.equal(nativeWindowMaterial('linux', '6.1.0'), undefined);
});
