import test from 'node:test';
import assert from 'node:assert/strict';
import { copyTerminalSelection } from '../src/renderer/workspace/terminalClipboard';

function fallbackDocument(fail = false) {
  let copied = '',
    restored = 0,
    removed = 0,
    selected = false;
  const input = {
    value: '',
    tabIndex: 0,
    style: { cssText: '' },
    setAttribute() {},
    focus() {},
    select() {
      selected = true;
    },
    setSelectionRange(start: number, end: number) {
      assert.equal(start, 0);
      assert.equal(end, input.value.length);
    },
    remove() {
      removed++;
    },
  };
  const document = {
    activeElement: {
      focus(options: FocusOptions) {
        assert.equal(options.preventScroll, true);
        restored++;
      },
    },
    createElement(tag: string) {
      assert.equal(tag, 'textarea');
      return input;
    },
    body: {
      append(value: unknown) {
        assert.equal(value, input);
      },
    },
    execCommand(command: string) {
      assert.equal(command, 'copy');
      assert.equal(selected, true);
      if (fail) throw new Error('copy-denied');
      copied = input.value;
      return true;
    },
  } as unknown as Document;
  return { document, state: () => ({ copied, restored, removed }) };
}

test('HTTP terminal selection copies synchronously without Clipboard API and restores focus', async () => {
  const f = fallbackDocument();
  const done = copyTerminalSelection('中文终端\nsecond line', { document: f.document });
  assert.deepEqual(f.state(), { copied: '中文终端\nsecond line', restored: 1, removed: 1 });
  assert.equal(await done, true);
});

test('secure clipboard success does not move terminal focus', async () => {
  const f = fallbackDocument();
  const calls: string[] = [];
  assert.equal(
    await copyTerminalSelection('selected', {
      document: f.document,
      clipboard: {
        writeText: async (text) => {
          calls.push(text);
        },
      },
    }),
    true,
  );
  assert.deepEqual(calls, ['selected']);
  assert.deepEqual(f.state(), { copied: '', restored: 0, removed: 0 });
});

test('denied Clipboard API uses DOM copy and failures still clean up focus without rejecting', async () => {
  for (const failed of [false, true]) {
    const f = fallbackDocument(failed);
    const copied = await copyTerminalSelection('selection', {
      document: f.document,
      clipboard: {
        writeText: async () => {
          throw new Error('permission-denied');
        },
      },
    });
    assert.equal(copied, !failed);
    assert.equal(f.state().removed, 1);
    assert.equal(f.state().restored, 1);
  }
});
