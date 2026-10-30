import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowAttentionChannel, type WindowAttention } from '../src/core/window-attention';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('native attention caches an event received before the renderer subscribes', () => {
  let event!: (value: WindowAttention) => void;
  let requests = 0;
  const channel = createWindowAttentionChannel({
    listen: (listener) => {
      event = listener;
      return () => {};
    },
    snapshot: async () => {
      requests++;
      return { visible: true, focused: true, epoch: 0 };
    },
  });
  event({ visible: false, focused: false, epoch: 2 });
  const values: WindowAttention[] = [];
  const stop = channel.subscribe((value) => values.push(value));
  assert.deepEqual(values, [{ visible: false, focused: false, epoch: 2 }]);
  assert.equal(requests, 0);
  stop();
  event({ visible: true, focused: true, epoch: 3 });
  assert.equal(values.length, 1);
  channel.dispose();
});

test('initial native handshake cannot overwrite a newer blur or restore event', async () => {
  let event!: (value: WindowAttention) => void;
  let stopped = false;
  const result = deferred<WindowAttention>();
  const channel = createWindowAttentionChannel({
    listen: (listener) => {
      event = listener;
      return () => {
        stopped = true;
      };
    },
    snapshot: () => result.promise,
  });
  const values: WindowAttention[] = [];
  channel.subscribe((value) => values.push(value));
  event({ visible: false, focused: false, epoch: 1 });
  event({ visible: true, focused: true, epoch: 2 });
  result.resolve({ visible: true, focused: true, epoch: 0 });
  await result.promise;
  assert.deepEqual(
    values.map((value) => value.epoch),
    [1, 2],
  );
  const restored: WindowAttention[] = [];
  channel.subscribe((value) => restored.push(value));
  assert.deepEqual(restored, [{ visible: true, focused: true, epoch: 2 }]);
  channel.dispose();
  event({ visible: false, focused: false, epoch: 3 });
  assert.equal(stopped, true);
  assert.equal(values.length, 2);
});

test('late native handshake after preload disposal cannot notify a suspended renderer', async () => {
  const result = deferred<WindowAttention>();
  const channel = createWindowAttentionChannel({ listen: () => () => {}, snapshot: () => result.promise });
  const values: WindowAttention[] = [];
  channel.subscribe((value) => values.push(value));
  channel.dispose();
  result.resolve({ visible: true, focused: true, epoch: 0 });
  await result.promise;
  assert.deepEqual(values, []);
});
