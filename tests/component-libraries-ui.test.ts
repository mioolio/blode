import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ComponentLibrariesDialog from '../src/renderer/components/ComponentLibrariesDialog';
import {
  ComponentLibrariesModel,
  type ComponentLibrariesBackend,
} from '../src/renderer/components/componentLibrariesModel';
import type {
  ComponentLibrariesState,
  ComponentSearchResult,
  ComponentImportRequest,
} from '../src/shared/components';
import type { LogEvent } from '../src/shared/contracts';
import type { Studio } from '../src/renderer/workspace/useStudio';
import { translate } from '../src/renderer/i18n';

const root = 'C:/projects/device';
const state: ComponentLibrariesState = {
  projectRoot: root,
  manifestPath: '.blode/components.json',
  components: [],
  provided: [],
};
const result = (query: string): ComponentSearchResult => ({
  query,
  entries: [{ name: query, versions: ['1.0.0'], latestVersion: '1.0.0' }],
  truncated: false,
});
function backend(overrides: Partial<ComponentLibrariesBackend> = {}): ComponentLibrariesBackend {
  return {
    componentsState: async () => structuredClone(state),
    componentsSearch: async (query) => result(query),
    componentsInstall: async () => structuredClone(state),
    componentsImport: async () => structuredClone(state),
    componentsRemove: async () => structuredClone(state),
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('opening the library dialog without a project renders a clear state and does not search', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let calls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      blode: backend({
        componentsSearch: async (query) => {
          calls++;
          return result(query);
        },
      }),
    },
  });
  try {
    const studio = {
      t: (key: string) => translate('zh-CN', key),
      state: { workspaceOpen: false, projectRoot: '' },
      busy: '',
    } as unknown as Studio;
    const html = renderToStaticMarkup(createElement(ComponentLibrariesDialog, { studio, onClose() {} }));
    assert.match(html, /role="dialog"/);
    assert.match(html, /请先打开项目/);
    assert.match(html, /查找库/);
    assert.match(html, /本地导入/);
    assert.match(html, /disabled="" aria-label="刷新"/);
    assert.equal(calls, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('local state loading never searches the network and project-less mutations cannot dispatch', async () => {
  let reads = 0,
    searches = 0,
    writes = 0;
  const api = backend({
    componentsState: async () => {
      reads++;
      return state;
    },
    componentsSearch: async (query) => {
      searches++;
      return result(query);
    },
    componentsImport: async () => {
      writes++;
      return state;
    },
  });
  const empty = new ComponentLibrariesModel(api, '');
  await empty.load();
  assert.equal(await empty.import('C:/library', 'directory'), false);
  assert.equal(empty.getSnapshot().error, 'components.noProject');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const project = new ComponentLibrariesModel(api, root);
  await project.load();
  assert.equal(reads, 1);
  assert.equal(searches, 0);
});

test('older search successes and failures do not replace the current query', async () => {
  const first = deferred<ComponentSearchResult>(),
    second = deferred<ComponentSearchResult>();
  const api = backend({ componentsSearch: (query) => (query === 'old' ? first.promise : second.promise) });
  const model = new ComponentLibrariesModel(api, root);
  model.setQuery('old');
  const old = model.search();
  model.setQuery('current');
  const current = model.search();
  second.resolve(result('current'));
  await current;
  first.reject(new Error('old request failed'));
  await old;
  assert.equal(model.getSnapshot().search?.query, 'current');
  assert.equal(model.getSnapshot().error, '');
  assert.equal(model.getSnapshot().searching, false);
  const stale = deferred<ComponentSearchResult>();
  const next = new ComponentLibrariesModel(backend({ componentsSearch: () => stale.promise }), root);
  next.setQuery('before typing');
  const pending = next.search();
  next.setQuery('after typing');
  stale.resolve(result('before typing'));
  await pending;
  assert.equal(next.getSnapshot().search, undefined);
  assert.equal(next.getSnapshot().query, 'after typing');
});

test('duplicate import preserves raw host errors and allows retry without replacing existing libraries', async () => {
  const library = {
    id: 'display',
    name: 'Display',
    kind: 'arduino' as const,
    path: 'libraries/Display',
    source: { type: 'directory' as const },
    includes: ['libraries/Display/src'],
    sources: [],
    dependencies: ['Bus (>=1.0.0)'],
  };
  const existing = { ...state, components: [library] };
  const requests: ComponentImportRequest[] = [];
  const model = new ComponentLibrariesModel(
    backend({
      componentsState: async () => existing,
      componentsImport: async (request) => {
        requests.push(request);
        throw new Error('error.componentDuplicate: Display (libraries/Display)');
      },
    }),
    root,
  );
  await model.load();
  assert.equal(await model.import('D:/sources/Display', 'directory'), false);
  assert.equal(model.getSnapshot().error, 'error.componentDuplicate: Display (libraries/Display)');
  assert.equal(model.getSnapshot().data?.components[0], library);
  assert.equal(model.getSnapshot().operation, null);
  assert.equal(model.getSnapshot().completed, false);
  assert.deepEqual(requests, [
    { path: 'D:/sources/Display', kind: 'directory', expectedProjectRoot: root, confirm: true },
  ]);
  await model.import('D:/Display.zip', 'archive');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].kind, 'archive');
});

test('project changes and closed dialogs reject late state or writes', async () => {
  let writes = 0;
  const changed = new ComponentLibrariesModel(
    backend({
      componentsState: async () => ({ ...state, projectRoot: 'C:/other' }),
      componentsInstall: async () => {
        writes++;
        return state;
      },
    }),
    root,
  );
  await changed.load();
  assert.equal(changed.getSnapshot().error, 'components.projectChanged');
  assert.equal(await changed.install('Display', '1.0.0'), false);
  assert.equal(writes, 0);
  const pending = deferred<ComponentLibrariesState>();
  const model = new ComponentLibrariesModel(backend({ componentsState: () => pending.promise }), root);
  const load = model.load();
  model.dispose();
  pending.resolve(state);
  await load;
  assert.equal(model.getSnapshot().data, undefined);
  assert.equal(await model.import('D:/Display', 'directory'), false);
});

test('progress belongs to the component operation and unrelated installs cannot replace it', async () => {
  const pending = deferred<ComponentLibrariesState>();
  const model = new ComponentLibrariesModel(backend({ componentsInstall: () => pending.promise }), root);
  await model.load();
  const action = model.install('Display', '1.0.0');
  const event = (id: string, tool: string, phase: 'starting' | 'downloading'): LogEvent => ({
    kind: 'status',
    level: 'info',
    message: phase,
    time: '2026-10-30T00:00:00Z',
    installation: { id, tool, phase, status: 'running', updatedAt: '2026-10-30T00:00:00Z' },
  });
  model.receive(event('unrelated', 'GNU Arm', 'starting'));
  assert.equal(model.getSnapshot().installation, undefined);
  model.receive(event('mine', 'components', 'starting'));
  model.receive(event('mine', 'Display', 'downloading'));
  model.receive(event('different', 'components', 'starting'));
  assert.equal(model.getSnapshot().installation?.id, 'mine');
  assert.equal(model.getSnapshot().installation?.logs.length, 2);
  pending.resolve(state);
  assert.equal(await action, true);
  model.receive(event('different', 'components', 'starting'));
  assert.equal(model.getSnapshot().installation?.id, 'mine');
});
