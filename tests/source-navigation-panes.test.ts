import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceNavigation, type NavigationPane } from '../src/renderer/workspace/sourceNavigation';
import type { SourceLocation } from '../src/shared/language';
const location = (path: string, line = 1, externalId?: string): SourceLocation => ({
  path,
  line,
  column: 1,
  endLine: line,
  endColumn: 2,
  ...(externalId ? { externalId } : {}),
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const state = { root: '/project', primary: 'main.c', secondary: 'main.c', active: true };
  const opened: { pane: NavigationPane; path: string }[] = [],
    located: { pane: NavigationPane; target: SourceLocation }[] = [],
    errors: unknown[] = [];
  const loads = new Map<string, ReturnType<typeof deferred<{ path: string }>>>();
  const navigator = new SourceNavigation({
    snapshot: () => ({ ...state }),
    exists: (path) => ['main.c', 'a.h', 'b.h'].includes(path),
    external: (id) => {
      const item = deferred<{ path: string }>();
      loads.set(id, item);
      return item.promise;
    },
    open: (pane, path) => {
      opened.push({ pane, path });
      state[pane] = path;
    },
    locate: (pane, target) => located.push({ pane, target }),
    failed: (error) => errors.push(error),
  });
  return { state, opened, located, errors, loads, navigator };
}
test('secondary navigation and back keep the primary file and its separate return position', async () => {
  const f = fixture();
  assert.equal(
    await f.navigator.visit('/project', location('a.h'), location('main.c', 64), 'secondary'),
    true,
  );
  assert.equal(f.state.primary, 'main.c');
  assert.equal(await f.navigator.visit('/project', location('b.h'), location('main.c', 2), 'primary'), true);
  await f.navigator.back('secondary');
  assert.equal(f.state.primary, 'b.h');
  assert.equal(f.located.at(-1)?.target.line, 64);
  assert.equal(f.located.at(-1)?.pane, 'secondary');
  await f.navigator.back('primary');
  assert.equal(f.located.at(-1)?.target.line, 2);
  assert.equal(f.located.at(-1)?.pane, 'primary');
});
test('independent panes do not cancel each other while SDK source is loading', async () => {
  const f = fixture();
  const secondary = f.navigator.visit(
    '/project',
    location('@external/x/header.h', 10, 'x'),
    location('main.c', 64),
    'secondary',
  );
  await f.navigator.visit('/project', location('b.h'), location('main.c', 2), 'primary');
  f.loads.get('x')!.resolve({ path: '@external/x/header.h' });
  assert.equal(await secondary, true);
  assert.equal(f.state.primary, 'b.h');
  assert.equal(f.state.secondary, '@external/x/header.h');
});
test('late file loads cannot reopen a closed pane, replace a manually selected file, or leave home', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.state.secondary = '';
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.secondary = 'b.h';
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.root = '/other';
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.active = false;
    },
  ]) {
    const f = fixture();
    const pending = f.navigator.visit(
      '/project',
      location('@external/x/header.h', 10, 'x'),
      location('main.c'),
      'secondary',
    );
    mutate(f);
    f.loads.get('x')!.resolve({ path: '@external/x/header.h' });
    assert.equal(await pending, false);
    assert.deepEqual(f.opened, []);
  }
});
test('a newer query in the same pane wins and reset suppresses delayed errors', async () => {
  const f = fixture();
  const first = f.navigator.visit('/project', location('old', 1, 'old'), undefined, 'secondary');
  const second = f.navigator.visit('/project', location('new', 2, 'new'), undefined, 'secondary');
  f.loads.get('new')!.resolve({ path: 'new' });
  assert.equal(await second, true);
  f.loads.get('old')!.resolve({ path: 'old' });
  assert.equal(await first, false);
  assert.deepEqual(f.opened, [{ pane: 'secondary', path: 'new' }]);
  const failure = f.navigator.visit('/project', location('failed', 1, 'failed'), undefined, 'secondary');
  f.navigator.reset();
  f.loads.get('failed')!.reject(Error('late'));
  assert.equal(await failure, false);
  assert.deepEqual(f.errors, []);
});
