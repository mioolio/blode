import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCompletions,
  setCompletionProject,
  externalSourceForUri,
  sourcePathForUri,
  registerExternalSource,
  definitionOriginForEditor,
} from '../src/renderer/editor/completionProvider';
import { externalModelIsRefreshing } from '../src/renderer/editor/externalModelUpdates';

test('Monaco navigation resolves external capabilities lazily and preserves current draft references', async () => {
  const definitions = new Map<string, any>(),
    references = new Map<string, any>(),
    links = new Map<string, any>();
  const disposable = () => ({ dispose() {} });
  const monaco = {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    Uri: { file: (path: string) => ({ path, toString: () => 'file://' + path }) },
    editor: {
      getModels: () => [],
      getModel: () => ({ isDisposed: () => false, getValue: () => '', setValue() {} }),
      onDidCreateModel: disposable,
    },
    languages: {
      CompletionItemKind: {},
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: disposable,
      registerHoverProvider: disposable,
      registerDeclarationProvider: disposable,
      registerDefinitionProvider: (language: string, provider: any) => {
        definitions.set(language, provider);
        return disposable();
      },
      registerReferenceProvider: (language: string, provider: any) => {
        references.set(language, provider);
        return disposable();
      },
      registerLinkProvider: (language: string, provider: any) => {
        links.set(language, provider);
        return disposable();
      },
    },
  } as any;
  const id = 'a'.repeat(32),
    externalPath = `@external/${id}/esp_log.h`,
    root = '/workspace';
  const source = {
    id,
    path: externalPath,
    name: 'esp_log.h',
    displayPath: '/sdk/include/esp_log.h',
    content: '#define ESP_LOGI(...) log(__VA_ARGS__)\n',
    language: 'cpp',
    readonly: true,
  };
  let calls = 0;
  const original = globalThis.window;
  (globalThis as any).window = {
    blode: {
      languageNavigate: async (request: any) => {
        calls++;
        assert.equal(request.expectedProjectRoot, root);
        return request.kind === 'reference'
          ? [
              { path: 'main.ino', line: 99, column: 1, endLine: 99, endColumn: 9 },
              { path: externalPath, externalId: id, line: 1, column: 9, endLine: 1, endColumn: 17 },
            ]
          : [{ path: externalPath, externalId: id, line: 1, column: 1, endLine: 1, endColumn: 1 }];
      },
      languageOpenExternal: async (request: any) => {
        assert.equal(request.externalId, id);
        return source;
      },
    },
  };
  try {
    const content = '#include <esp_log.h>\nvoid setup() { ESP_LOGI("a", "b"); }';
    setCompletionProject([{ path: 'main.ino', content }], { projectRoot: root });
    registerCompletions(monaco);
    const model = {
      uri: { path: '/workspace/main.ino' },
      getValue: () => content,
      getWordAtPosition: () => ({ word: 'ESP_LOGI' }),
    };
    const token = { isCancellationRequested: false };
    const headerLinks = await links.get('cpp').provideLinks(model, token);
    assert.equal(calls, 0, 'painting include links does not scan or read host SDK files');
    assert.equal(headerLinks.links.length, 1);
    const result = await definitions
      .get('cpp')
      .provideDefinition(model, { lineNumber: 1, column: 15 }, token);
    assert.equal(result[0].uri.path, root + '/' + externalPath);
    assert.equal(externalSourceForUri(result[0].uri.path)?.readonly, true);
    assert.equal(sourcePathForUri(result[0].uri.path), externalPath);
    const usages = await references
      .get('cpp')
      .provideReferences(model, { lineNumber: 2, column: 17 }, {}, token);
    assert.deepEqual(
      usages
        .filter((item: any) => item.uri.path === '/workspace/main.ino')
        .map((item: any) => item.range.startLineNumber),
      [2],
      'stale saved line 99 is replaced by the current draft',
    );
    setCompletionProject([{ path: 'main.ino', content }], { projectRoot: '/other-project' });
    assert.equal(
      externalSourceForUri(result[0].uri.path),
      undefined,
      'external model mappings are scoped to their workspace',
    );
  } finally {
    (globalThis as any).window = original;
  }
});

function cancellation() {
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
  };
}
function delayed<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw Error('Navigation did not reach the expected stage');
}
function providers(
  t: TestContext,
  options: { navigate?: (request: any) => Promise<any[]>; external?: (request: any) => Promise<any> } = {},
) {
  const definitions = new Map<string, any>(),
    links = new Map<string, any>(),
    references = new Map<string, any>(),
    cancelled: any[] = [];
  let hostCalls = 0,
    externalCalls = 0;
  const disposable = () => ({ dispose() {} }),
    monaco: any = {
      Range: class {
        constructor(
          public startLineNumber: number,
          public startColumn: number,
          public endLineNumber: number,
          public endColumn: number,
        ) {}
      },
      Uri: { file: (path: string) => ({ path, toString: () => 'file://' + path }) },
      editor: {
        getModels: () => [],
        getModel: () => ({ isDisposed: () => false, getValue: () => '', setValue() {} }),
        onDidCreateModel: disposable,
        createModel: () => {
          throw Error('Late navigation created a model');
        },
      },
      languages: {
        CompletionItemKind: {},
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider: disposable,
        registerHoverProvider: disposable,
        registerDeclarationProvider: disposable,
        registerDefinitionProvider: (language: string, provider: any) => {
          definitions.set(language, provider);
          return disposable();
        },
        registerReferenceProvider: (language: string, provider: any) => {
          references.set(language, provider);
          return disposable();
        },
        registerLinkProvider: (language: string, provider: any) => {
          links.set(language, provider);
          return disposable();
        },
      },
    };
  const original = globalThis.window;
  (globalThis as any).window = {
    blode: {
      languageNavigate: async (request: any) => {
        hostCalls++;
        return options.navigate?.(request) ?? [];
      },
      languageCancel: async (request: any) => {
        cancelled.push(request);
      },
      languageOpenExternal: async (request: any) => {
        externalCalls++;
        return options.external?.(request);
      },
    },
  };
  t.after(() => {
    (globalThis as any).window = original;
  });
  setCompletionProject([], { projectRoot: '/navigation-tests' });
  setCompletionProject(
    [{ path: 'main.c', content: '#include <missing.h>\nvoid main(void) { missing(); }' }],
    { projectRoot: '/navigation-tests' },
  );
  registerCompletions(monaco);
  const model = {
    uri: { path: '/navigation-tests/main.c' },
    version: 1,
    disposed: false,
    getVersionId() {
      return this.version;
    },
    isDisposed() {
      return this.disposed;
    },
    getWordAtPosition: () => ({ word: 'missing' }),
    getValue: () => '#include <missing.h>\nvoid main(void) { missing(); }',
  };
  return {
    monaco,
    definitions: definitions.get('cpp'),
    links: links.get('cpp'),
    references: references.get('cpp'),
    model,
    cancelled,
    hostCalls: () => hostCalls,
    externalCalls: () => externalCalls,
  };
}

test('repeated unresolved definitions share host work and do not start work for cancelled Monaco tokens', async (t) => {
  const lookup = delayed<any[]>(),
    f = providers(t, { navigate: () => lookup.promise }),
    one = cancellation(),
    two = cancellation();
  const a = f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, one);
  const b = f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, two);
  await until(() => f.hostCalls() === 1);
  one.cancel();
  assert.deepEqual(await a, []);
  assert.equal(f.cancelled.length, 0);
  two.cancel();
  assert.deepEqual(await b, []);
  assert.equal(f.cancelled.length, 1);
  lookup.resolve([]);
  const before = f.hostCalls(),
    stop = cancellation();
  stop.cancel();
  f.model.getWordAtPosition = () => {
    throw Error('Cancelled request inspected the model');
  };
  assert.deepEqual(await f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, stop), []);
  assert.equal(f.hostCalls(), before);
});

test('late external sources cannot reopen stale navigation after an edit, disposal or project change', async (t) => {
  const id = 'b'.repeat(32),
    externalPath = `@external/${id}/header.h`,
    opened = delayed<any>();
  const f = providers(t, {
    navigate: async () => [
      { path: externalPath, externalId: id, line: 1, column: 1, endLine: 1, endColumn: 3 },
    ],
    external: () => opened.promise,
  });
  const result = f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, cancellation());
  await until(() => f.externalCalls() === 1);
  f.model.version++;
  opened.resolve({
    id,
    path: externalPath,
    name: 'header.h',
    displayPath: '/sdk/header.h',
    content: '#define missing 1',
    language: 'cpp',
    readonly: true,
  });
  assert.deepEqual(await result, []);
  assert.equal(externalSourceForUri('/navigation-tests/' + externalPath), undefined);
  const lookup = delayed<any[]>(),
    second = providers(t, { navigate: () => lookup.promise });
  const stale = second.definitions.provideDefinition(
    second.model,
    { lineNumber: 2, column: 20 },
    cancellation(),
  );
  await until(() => second.hostCalls() === 1);
  setCompletionProject([{ path: 'other.c', content: 'void other(void){}' }], {
    projectRoot: '/another-root',
  });
  assert.deepEqual(await stale, []);
  assert.equal(second.cancelled.length, 1);
  lookup.resolve([]);
});

test('external include links reuse the parsed model and expired links cannot perform host I/O', async (t) => {
  const f = providers(t),
    id = 'c'.repeat(32),
    externalPath = `@external/${id}/header.h`;
  registerExternalSource({
    id,
    path: externalPath,
    name: 'header.h',
    displayPath: '/sdk/header.h',
    content: '#include <next.h>',
    language: 'cpp',
    readonly: true,
  });
  let reads = 0;
  f.model.uri.path = '/navigation-tests/' + externalPath;
  f.model.getValue = () => {
    reads++;
    return '#include <next.h>';
  };
  const first = await f.links.provideLinks(f.model, cancellation());
  for (let i = 0; i < 30; i++) await f.links.provideLinks(f.model, cancellation());
  assert.equal(reads, 1);
  assert.equal(f.hostCalls(), 0);
  f.model.version++;
  assert.equal(await f.links.resolveLink(first.links[0], cancellation()), first.links[0]);
  assert.equal(f.hostCalls(), 0);
  await f.links.provideLinks(f.model, cancellation());
  assert.equal(reads, 2);
});

test('concurrent definitions open the same external capability once', async (t) => {
  const id = 'd'.repeat(32),
    externalPath = `@external/${id}/shared.h`,
    opened = delayed<any>(),
    lookup = delayed<any[]>();
  const f = providers(t, {
    navigate: () => lookup.promise,
    external: () => opened.promise,
  });
  const one = f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, cancellation());
  const two = f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, cancellation());
  await until(() => f.hostCalls() === 1);
  lookup.resolve([{ path: externalPath, externalId: id, line: 1, column: 1, endLine: 1, endColumn: 3 }]);
  await until(() => f.externalCalls() === 1);
  opened.resolve({
    id,
    path: externalPath,
    name: 'shared.h',
    displayPath: '/sdk/shared.h',
    content: '#define missing 1',
    language: 'cpp',
    readonly: true,
  });
  assert.equal((await one).length, 1);
  assert.equal((await two).length, 1);
  assert.equal(f.hostCalls(), 1);
  assert.equal(f.externalCalls(), 1);
});

test('same-file split editors keep distinct origins and nested Peek reads its actual owner', async (t) => {
  const f = providers(t, {
    navigate: async () => [{ path: 'main.c', line: 1, column: 1, endLine: 1, endColumn: 2 }],
  });
  let focused: any;
  const editor = (column: number) => ({
    getModel: () => f.model,
    getPosition: () => ({ lineNumber: 2, column }),
    hasTextFocus() {
      return focused === this;
    },
    hasWidgetFocus: () => false,
  });
  const one = editor(20),
    two = editor(28);
  f.monaco.editor.getEditors = () => [one, two];
  focused = one;
  await f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, cancellation());
  focused = two;
  await f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 28 }, cancellation());
  assert.equal(definitionOriginForEditor(one as any)?.column, 20);
  assert.equal(definitionOriginForEditor(two as any)?.column, 28);
  const peek = { getModel: () => null, getParentEditor: () => one };
  assert.equal(definitionOriginForEditor(peek as any)?.column, 20);
  two.getPosition = () => ({ lineNumber: 2, column: 36 });
  await f.references.provideReferences(f.model, { lineNumber: 2, column: 36 }, {}, cancellation());
  assert.equal(
    definitionOriginForEditor(two as any)?.column,
    36,
    'reference navigation replaces the previous definition origin in its own pane',
  );
  assert.equal(definitionOriginForEditor(one as any)?.column, 20);
  await f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 99 }, cancellation());
  assert.equal(
    definitionOriginForEditor(two as any)?.column,
    36,
    'background hover does not overwrite a focused pane origin',
  );
  f.model.version++;
  assert.equal(definitionOriginForEditor(one as any), undefined);
});

test('fresh SDK coordinates refresh an existing read-only Peek model and notify open tabs', async (t) => {
  const id = 'e'.repeat(32),
    externalPath = `@external/${id}/sdk.h`,
    uri = '/navigation-tests/' + externalPath;
  let content = '#define missing 1\n',
    line = 1,
    pendingRefresh: Promise<any> | undefined;
  const f = providers(t, {
    navigate: async () => [
      { path: externalPath, externalId: id, line, column: 1, endLine: line, endColumn: 3 },
    ],
    external: async () =>
      pendingRefresh ?? {
        id,
        path: externalPath,
        name: 'sdk.h',
        displayPath: '/sdk/sdk.h',
        content,
        language: 'cpp',
        readonly: true,
      },
  });
  const notifications: any[] = [],
    markers: boolean[] = [];
  (window as any).dispatchEvent = (event: CustomEvent) => {
    notifications.push(event.detail);
    return true;
  };
  const existing = {
    text: content,
    version: 1,
    undo: ['old snapshot'],
    isDisposed: () => false,
    getValue() {
      return this.text;
    },
    setValue(value: string) {
      markers.push(externalModelIsRefreshing(this as any));
      this.text = value;
      this.version++;
      this.undo = [];
    },
  };
  f.monaco.editor.getModel = (target: any) => (target.path === uri ? existing : undefined);
  const first = await f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, cancellation());
  assert.equal(first[0].range.startLineNumber, 1);
  const before = externalSourceForUri(uri)!;
  content = '\n#define missing 2\n';
  line = 2;
  const second = await f.definitions.provideDefinition(
    f.model,
    { lineNumber: 2, column: 20 },
    cancellation(),
  );
  assert.equal(second[0].range.startLineNumber, 2);
  assert.equal(existing.text, content);
  assert.equal(f.hostCalls(), 2);
  assert.equal(f.externalCalls(), 2);
  assert.deepEqual(markers, [true]);
  assert.equal(externalModelIsRefreshing(existing as any), false);
  assert.deepEqual(existing.undo, []);
  assert.equal(notifications.at(-1).root, '/navigation-tests');
  assert.equal(notifications.at(-1).source.content, content);
  const count = notifications.length;
  registerExternalSource(before);
  assert.equal(
    externalSourceForUri(uri)!.content,
    content,
    'a stale React registration cannot overwrite a fresh SDK snapshot',
  );
  assert.equal(notifications.length, count);
  const late = delayed<any>();
  pendingRefresh = late.promise;
  const stop = cancellation(),
    cancelled = f.definitions.provideDefinition(f.model, { lineNumber: 2, column: 20 }, stop);
  await until(() => f.externalCalls() === 3);
  stop.cancel();
  late.resolve({ ...before, content: 'late stale content' });
  assert.deepEqual(await cancelled, []);
  assert.equal(existing.text, content);
  assert.equal(
    notifications.length,
    count,
    'cancelled refresh cannot overwrite the source cache or open tabs',
  );
});
