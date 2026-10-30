import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationRequests } from '../src/renderer/editor/navigationRequests';
import type { LanguageNavigationRequest, SourceLocation } from '../src/shared/language';

const request: LanguageNavigationRequest = {
  expectedProjectRoot: '/project',
  path: 'main.c',
  kind: 'definition',
  symbol: 'missing',
};
function token() {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('coalesced Monaco consumers cancel independently and the last consumer aborts real host work', async () => {
  const pending = deferred<SourceLocation[]>(),
    calls: LanguageNavigationRequest[] = [],
    cancelled: unknown[] = [];
  const broker = new NavigationRequests({
    invoke: async (input) => {
      calls.push(input);
      return pending.promise;
    },
    cancel: async (input) => {
      cancelled.push(input);
    },
  });
  const one = token(),
    two = token(),
    a = broker.query(request, one, () => true),
    b = broker.query(request, two, () => true);
  await tick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].requestId!, /^[a-f0-9]{32}$/);
  one.cancel();
  assert.deepEqual(await a, []);
  assert.equal(cancelled.length, 0);
  two.cancel();
  assert.deepEqual(await b, []);
  assert.deepEqual(cancelled, [{ expectedProjectRoot: '/project', requestId: calls[0].requestId }]);
  assert.equal(one.listeners.size, 0);
  assert.equal(two.listeners.size, 0);
  pending.resolve([{ path: 'late.h', line: 1, column: 1, endLine: 1, endColumn: 3 }]);
  await tick();
  assert.deepEqual(await broker.query(request, token(), () => true), [
    { path: 'late.h', line: 1, column: 1, endLine: 1, endColumn: 3 },
  ]);
  assert.equal(calls.length, 2, 'cancelled work cannot populate the result cache');
});

test('negative lookups are briefly cached and reset, expired results and errors are retried', async () => {
  let now = 0,
    calls = 0;
  const broker = new NavigationRequests({
    now: () => now,
    invoke: async () => {
      calls++;
      return [];
    },
    cancel: async () => {},
  });
  for (let i = 0; i < 30; i++) assert.deepEqual(await broker.query(request, token(), () => true), []);
  assert.equal(calls, 1);
  now = 501;
  await broker.query(request, token(), () => true);
  assert.equal(calls, 2);
  broker.reset();
  await broker.query(request, token(), () => true);
  assert.equal(calls, 3);
  let failed = true;
  const errors = new NavigationRequests({
    invoke: async () => {
      if (failed) throw Error('offline');
      return [];
    },
    cancel: async () => {},
  });
  await assert.rejects(
    errors.query(request, token(), () => true),
    /offline/,
  );
  failed = false;
  assert.deepEqual(await errors.query(request, token(), () => true), []);
});

test('cancel-before-start, project resets and stale model guards never surface late results', async () => {
  let calls = 0,
    current = true;
  const pending = deferred<SourceLocation[]>(),
    cancelled: unknown[] = [];
  const broker = new NavigationRequests({
    invoke: async () => {
      calls++;
      return pending.promise;
    },
    cancel: async (input) => {
      cancelled.push(input);
    },
  });
  const first = token(),
    early = broker.query(request, first, () => current);
  first.cancel();
  assert.deepEqual(await early, []);
  await tick();
  assert.equal(calls, 0);
  const second = broker.query(request, token(), () => current);
  await tick();
  broker.reset();
  assert.deepEqual(await second, []);
  assert.equal(cancelled.length, 1);
  const third = broker.query(request, token(), () => current);
  await tick();
  current = false;
  pending.resolve([{ path: 'header.h', line: 5, column: 1, endLine: 5, endColumn: 2 }]);
  assert.deepEqual(await third, []);
  const already = token();
  already.cancel();
  assert.deepEqual(await broker.query(request, already, () => true), []);
});

test('synchronous transport failures are handled and the result cache remains bounded', async () => {
  const throws = new NavigationRequests({
    invoke: () => {
      throw Error('closed renderer');
    },
    cancel: async () => {},
  });
  await assert.rejects(
    throws.query(request, token(), () => true),
    /closed renderer/,
  );
  const pending = deferred<SourceLocation[]>(),
    stop = token();
  const cancelThrows = new NavigationRequests({
    invoke: () => pending.promise,
    cancel: () => {
      throw Error('disposed transport');
    },
  });
  const cancelled = cancelThrows.query(request, stop, () => true);
  await tick();
  stop.cancel();
  assert.deepEqual(await cancelled, []);
  pending.reject(Error('late failure'));
  await tick();
  let calls = 0;
  const broker = new NavigationRequests({
    invoke: async () => {
      calls++;
      return [];
    },
    cancel: async () => {},
  });
  for (let i = 0; i < 80; i++) await broker.query({ ...request, symbol: 'missing' + i }, token(), () => true);
  await broker.query(request, token(), () => true);
  assert.equal(calls, 81);
  await broker.query({ ...request, symbol: 'missing79' }, token(), () => true);
  assert.equal(calls, 81);
});
