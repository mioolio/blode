import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserWindow } from 'electron';
import { currentRendererFrame, sendToRenderer } from '../src/core/renderer-delivery';
import { IPC_CANCELLED, unwrapIpcResponse, withIpcCancellation } from '../src/shared/ipc-response';

function fixture() {
  const messages: unknown[] = [];
  const frame = {
    detached: false,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    send(...args: unknown[]) {
      messages.push(args);
    },
  };
  const window = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      mainFrame: frame,
      send() {
        throw new Error('must not use WebContents.send');
      },
    },
  };
  return { window, frame, messages, target: window as unknown as BrowserWindow };
}

test('renderer messages use a live main frame and ignore closed or detached destinations', () => {
  const f = fixture();
  assert.equal(sendToRenderer(f.target, 'test', { ok: true }), true);
  assert.deepEqual(f.messages, [['test', { ok: true }]]);
  f.frame.detached = true;
  assert.equal(sendToRenderer(f.target, 'test'), false);
  f.frame.detached = false;
  f.frame.destroyed = true;
  assert.equal(sendToRenderer(f.target, 'test'), false);
  f.frame.destroyed = false;
  f.window.webContents.destroyed = true;
  assert.equal(sendToRenderer(f.target, 'test'), false);
  f.window.webContents.destroyed = false;
  f.window.destroyed = true;
  assert.equal(sendToRenderer(f.target, 'test'), false);
  assert.equal(sendToRenderer(null, 'test'), false);
  assert.equal(f.messages.length, 1);
});

test('a frame disposed before WebContents access does not emit a delivery warning', () => {
  const f = fixture();
  Object.defineProperty(f.window.webContents, 'mainFrame', {
    get() {
      throw new Error('Render frame was disposed');
    },
  });
  assert.equal(currentRendererFrame(f.target.webContents), undefined);
  assert.equal(sendToRenderer(f.target, 'test'), false);
});

test('a disposal race is suppressed but unrelated serialization failures still surface', () => {
  const f = fixture();
  f.frame.send = () => {
    throw new Error('clone error');
  };
  assert.throws(() => sendToRenderer(f.target, 'test'), /clone error/);
  f.frame.send = () => {
    f.frame.destroyed = true;
    throw new Error('disposed');
  };
  assert.equal(sendToRenderer(f.target, 'test'), false);
});

test('expected IPC cancellation rejects in preload while real failures and values retain semantics', async () => {
  const cancelled = await withIpcCancellation(() => {
    throw new Error('error.operationCancelled');
  });
  assert.deepEqual(cancelled, IPC_CANCELLED);
  assert.throws(() => unwrapIpcResponse(cancelled), /error.operationCancelled/);
  await assert.rejects(
    withIpcCancellation(() => {
      throw new Error('error.unauthorized');
    }),
    /error.unauthorized/,
  );
  for (const value of [undefined, null, false, 0, '', { ok: true }, ['value']])
    assert.deepEqual(unwrapIpcResponse(await withIpcCancellation(async () => value)), value);
});

test('a replaced frame is not mistaken for the frame whose delivery failed', () => {
  const f = fixture();
  f.frame.send = () => {
    f.window.webContents.mainFrame = fixture().frame;
    throw new Error('old frame disposed during navigation');
  };
  assert.equal(sendToRenderer(f.target, 'test'), false);
});
