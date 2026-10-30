import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { attachInlineCompletions, type PredictionFeedback } from '../src/renderer/editor/inlineCompletions';
import type { AiPredictionContext, AiPredictionRequest, AiPredictionSuggestion } from '../src/shared/ai';

const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

test('a pending preferences refresh cannot cancel an explicit manual action', async (t) => {
  const f = fixture(t, false);
  await flush();
  f.setRead(async () => {
    throw new Error('error.aiKeyMissing');
  });
  f.emit('host', { message: 'status.aiAssistanceChanged' });
  await f.actions.get('blode.ai.complete').run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.feedback.at(-1)?.message, 'error.aiKeyMissing');
  assert.equal(f.cancelled.includes(f.requests[0].id), false);
});
function fixture(t: TestContext, enabled = true, delay = 750) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldWindow = globalThis.window;
  const callbacks = new Map<string, Set<(...args: any[]) => void>>();
  const actions = new Map<string, any>(),
    requests: AiPredictionRequest[] = [],
    cancelled: string[] = [],
    feedback: PredictionFeedback[] = [];
  let text = '',
    version = 1,
    readonly = false,
    focused = true,
    cursor = { lineNumber: 1, column: 1 };
  let read: (id: string) => Promise<AiPredictionSuggestion | null> = async () => null;
  const event = (name: string) => (callback: (...args: any[]) => void) => {
    const set = callbacks.get(name) ?? new Set();
    callbacks.set(name, set);
    set.add(callback);
    return { dispose: () => set.delete(callback) };
  };
  const emit = (name: string, value?: unknown) => callbacks.get(name)?.forEach((callback) => callback(value));
  const model = { getVersionId: () => version, getOffsetAt: () => text.length, getValue: () => text };
  const editor = {
    createContextKey: () => ({ set() {} }),
    getModel: () => model,
    getPosition: () => cursor,
    getOption: () => readonly,
    hasTextFocus: () => focused,
    focus: () => {
      focused = true;
    },
    onDidChangeModelContent: event('content'),
    onDidChangeCursorPosition: event('cursor'),
    onDidChangeModel: event('model'),
    onDidFocusEditorText: event('focus'),
    onDidBlurEditorText: event('blur'),
    onDidCompositionStart: event('compositionStart'),
    onDidCompositionEnd: event('compositionEnd'),
    onKeyDown: event('key'),
    addAction: (action: any) => {
      actions.set(action.id, action);
      return { dispose: () => actions.delete(action.id) };
    },
    trigger() {},
    pushUndoStop() {},
    executeEdits() {},
  };
  const monaco = {
    editor: { EditorOption: { readOnly: 91 } },
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { Space: 10, Tab: 2, Escape: 9 },
    languages: { registerInlineCompletionsProvider: () => ({ dispose() {} }) },
  };
  Object.assign(globalThis, {
    window: {
      blode: {
        aiAssistanceState: async () => ({
          revision: 0,
          predictionEnabled: enabled,
          predictionDelayMs: delay,
          useBuiltins: true,
          entries: [],
          builtins: [],
        }),
        aiPredictionRequest: async (context: AiPredictionContext) => {
          const request = {
            ...context,
            id: `request-${requests.length}`,
            sequence: requests.length + 1,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          };
          requests.push(request);
          return request;
        },
        aiPredictionRead: ({ requestId }: { requestId: string }) => read(requestId),
        aiPredictionCancel: async ({ requestId }: { requestId: string }) => {
          cancelled.push(requestId);
        },
        onEvent: (callback: (...args: any[]) => void) => {
          const subscription = event('host')(callback);
          return () => subscription.dispose();
        },
      },
    },
  });
  const controller = attachInlineCompletions(monaco as any, editor as any, {
    projectRoot: () => '/project',
    path: () => 'main.c',
    onStatus: (value) => feedback.push(value),
  });
  t.after(() => {
    controller.dispose();
    Object.assign(globalThis, { window: oldWindow });
  });
  return {
    actions,
    requests,
    cancelled,
    feedback,
    emit,
    setRead: (next: typeof read) => {
      read = next;
    },
    setReadonly: () => {
      readonly = true;
    },
    type(value: string) {
      text += value;
      version++;
      cursor = { lineNumber: text.split('\n').length, column: (text.split('\n').at(-1)?.length ?? 0) + 1 };
      emit('content');
      emit('cursor');
    },
  };
}

test('all input is debounced by the persisted delay without language or minimum-length filters', async (t) => {
  const f = fixture(t, true, 1250);
  await flush();
  for (const input of ['中', '//这是什么', ' ', '\n', '"你好']) {
    const before = f.requests.length;
    f.type(input);
    t.mock.timers.tick(1249);
    await flush();
    assert.equal(f.requests.length, before);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(f.requests.length, before + 1);
    assert.ok(f.requests.at(-1)?.prefix.endsWith(input));
    assert.equal(f.requests.at(-1)?.manual, undefined);
  }
});

test('IME composition sends only the committed text after the configured interval', async (t) => {
  const f = fixture(t);
  await flush();
  f.emit('compositionStart');
  f.type('zhong');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.requests.length, 0);
  f.type('中');
  f.emit('compositionEnd');
  t.mock.timers.tick(749);
  await flush();
  assert.equal(f.requests.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].prefix.endsWith('中'));
});

test('manual context action and distinct shortcut request once with automatic mode off', async (t) => {
  const f = fixture(t, false);
  await flush();
  f.type('//这是什么');
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(f.requests.length, 0);
  const action = f.actions.get('blode.ai.complete');
  assert.equal(action.contextMenuGroupId, '9_blode_ai');
  assert.deepEqual(action.keybindings, [2048 | 512 | 10]);
  await action.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].manual, true);
  assert.equal(f.feedback.at(-1)?.kind, 'requesting');
  f.type('？');
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.ok(f.cancelled.includes(f.requests[0].id));
  f.setReadonly();
  await action.run();
  assert.equal(f.requests.length, 1);
});

test('completion errors, empty response and timeout are visible and stale replies remain ignored', async (t) => {
  const f = fixture(t, false);
  await flush();
  f.setRead(async () => {
    throw new Error('error.aiKeyMissing');
  });
  await f.actions.get('blode.ai.complete').run();
  assert.equal(f.feedback.at(-1)?.message, 'error.aiKeyMissing');
  f.setRead(async (requestId) => ({ requestId, text: '', createdAt: new Date().toISOString() }));
  await f.actions.get('blode.ai.complete').run();
  assert.equal(f.feedback.at(-1)?.kind, 'empty');
  f.setRead(async () => null);
  await f.actions.get('blode.ai.complete').run();
  t.mock.timers.tick(16000);
  await flush();
  assert.equal(f.feedback.at(-1)?.message, 'error.aiPredictionTimeout');
  let release!: (value: AiPredictionSuggestion) => void;
  f.setRead(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.actions.get('blode.ai.complete').run();
  await flush();
  const old = f.requests.at(-1)!;
  f.type('x');
  release({ requestId: old.id, text: 'old', createdAt: new Date().toISOString() });
  await pending;
  assert.equal(f.feedback.at(-1)?.kind, 'idle');
  assert.ok(f.cancelled.includes(old.id));
});
