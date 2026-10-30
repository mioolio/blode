import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAiEditorActions, type ApplyLocalAiEdit } from '../src/renderer/editor/aiActions';
import type { AiEditorContext } from '../src/renderer/workspace/aiContext';

function fixture(t: any) {
  const previousWindow = globalThis.window,
    events = new EventTarget();
  (globalThis as any).window = events;
  let text = 'before SELECT after',
    readonly = false,
    undoStops = 0,
    edits = 0,
    active = true;
  const context: AiEditorContext = {
    projectRoot: '/project',
    source: { path: 'main.c', content: text, selection: { start: 7, end: 13 } },
  };
  const actions = new Map<string, any>();
  const monaco = {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    editor: { EditorOption: { readOnly: 1 } },
  } as any;
  const editor = {
    addAction: (action: any) => {
      actions.set(action.id, action);
      return { dispose: () => actions.delete(action.id) };
    },
    getModel: () => ({
      getValue: () => text,
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    }),
    getOption: () => readonly,
    pushUndoStop: () => undoStops++,
    executeEdits: (_source: string, changes: any[]) => {
      edits++;
      const edit = changes[0];
      text = text.slice(0, edit.range.startColumn - 1) + edit.text + text.slice(edit.range.endColumn - 1);
      return true;
    },
  } as any;
  const attached = attachAiEditorActions(monaco, editor, {
    context: () => context,
    active: () => active,
    t: (key) => `translated:${key}`,
  });
  t.after(() => {
    attached.dispose();
    (globalThis as any).window = previousWindow;
  });
  const apply = (overrides: Partial<ApplyLocalAiEdit> = {}) => {
    let applied: boolean | undefined;
    const request: ApplyLocalAiEdit = {
      projectRoot: '/project',
      originalContent: 'before SELECT after',
      edit: { id: 'edit-1', path: 'main.c', start: 7, end: 13, text: 'UPDATED' },
      reply: (value) => {
        applied = value;
      },
      ...overrides,
    };
    events.dispatchEvent(new CustomEvent('blode:ai-apply-local', { detail: request }));
    return { request, applied };
  };
  return {
    context,
    events,
    actions,
    attached,
    apply,
    text: () => text,
    edits: () => edits,
    undoStops: () => undoStops,
    change: (value: string) => {
      text = value;
    },
    readonly: () => {
      readonly = true;
    },
    inactive: () => {
      active = false;
    },
  };
}

test('AI context actions publish the current selection and use localized labels', (t) => {
  const f = fixture(t);
  let opened: any;
  f.events.addEventListener('blode:ai-open', (event) => {
    opened = (event as CustomEvent).detail;
  });
  f.actions.get('blode.ai.ask').run();
  assert.equal(opened.intent, 'ask');
  assert.deepEqual(opened.context.source.selection, { start: 7, end: 13 });
  assert.equal(f.actions.get('blode.ai.ask').label, 'translated:ai.chat.ask');
  assert.equal(f.actions.get('blode.ai.edit').precondition, '!editorReadonly');
  f.inactive();
  let answered = false;
  f.events.dispatchEvent(
    new CustomEvent('blode:ai-context-request', {
      detail: {
        reply() {
          answered = true;
        },
      },
    }),
  );
  assert.equal(answered, false, 'inactive split editors do not override the selected editor context');
});

test('local AI edits replace only their authorized range and form one undo group', (t) => {
  const f = fixture(t),
    result = f.apply();
  assert.equal(result.applied, true);
  assert.equal(f.text(), 'before UPDATED after');
  assert.equal(f.edits(), 1);
  assert.equal(f.undoStops(), 2);
  const duplicate = f.apply({ handled: true });
  assert.equal(duplicate.applied, undefined);
  assert.equal(f.edits(), 1);
});

test('local AI edits reject stale text, read-only sources, invalid ranges and other projects', (t) => {
  const f = fixture(t);
  assert.equal(f.apply({ projectRoot: '/other-project' }).applied, undefined);
  assert.equal(
    f.apply({ edit: { id: 'different', path: 'other.c', start: 0, end: 1, text: 'x' } }).applied,
    undefined,
  );
  for (const range of [
    { start: -1, end: 3 },
    { start: 9, end: 2 },
    { start: 0, end: 100 },
    { start: 0.5, end: 2 },
  ])
    assert.equal(f.apply({ edit: { id: 'invalid', path: 'main.c', text: 'x', ...range } }).applied, false);
  f.change('user changed the file');
  assert.equal(f.apply().applied, false);
  f.change('before SELECT after');
  f.context.readonly = true;
  assert.equal(f.apply().applied, false);
  f.context.readonly = false;
  f.readonly();
  assert.equal(f.apply().applied, false);
  assert.equal(f.edits(), 0);
});

test('validation is side-effect free and disposing an editor releases its context listeners', (t) => {
  const f = fixture(t);
  assert.equal(f.apply({ validateOnly: true }).applied, true);
  assert.equal(f.text(), 'before SELECT after');
  assert.equal(f.edits(), 0);
  f.attached.dispose();
  assert.equal(f.actions.size, 0);
  assert.equal(f.apply().applied, undefined);
});
