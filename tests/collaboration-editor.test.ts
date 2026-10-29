import assert from 'node:assert/strict';
import { LocalUndoHistory } from '../src/shared/selective-undo';
import test from 'node:test';
import {
  applyTextChanges,
  mapTextOffset,
  mergeText,
  textChanges,
} from '../src/renderer/editor/collaborationText';

test('local browser history excludes remote edits when shared synchronization is disabled', () => {
  const history = new LocalUndoHistory();
  let text = 'alpha beta';
  const own = [{ start: 0, end: 5, text: 'ALPHA' }];
  history.record(text, own, true);
  text = applyTextChanges(text, own);
  const remote = [{ start: 6, end: 10, text: 'BETA' }];
  history.record(text, remote, false);
  text = applyTextChanges(text, remote);
  const changes = history.take(text, 'undo');
  assert.ok(changes);
  text = applyTextChanges(text, changes!);
  assert.equal(text, 'alpha BETA');
  const redo = history.take(text, 'redo');
  assert.ok(redo);
  text = applyTextChanges(text, redo!);
  assert.equal(text, 'ALPHA BETA');
});

test('local browser undo refuses overlapping remote text rather than using Monaco global history', () => {
  const history = new LocalUndoHistory();
  history.record('a', [{ start: 0, end: 1, text: 'hello' }], true);
  history.record('hello', [{ start: 1, end: 3, text: 'XX' }], false);
  assert.throws(() => history.take('hXXlo', 'undo'), /undoConflict/);
});

test('remote changes retain unchanged middle regions instead of replacing the whole document', () => {
  const before = 'one\nkeep reading here\nlast\n';
  const after = 'ONE\nkeep reading here\nLAST\n';
  const changes = textChanges(before, after);
  assert.equal(changes.length, 2);
  assert.equal(applyTextChanges(before, changes), after);
  assert.ok(changes.every((change) => change.end <= 4 || change.start >= 22));
});

test('reader anchor follows its original content when lines above it are inserted or removed', () => {
  const before = Array.from({ length: 100 }, (_, i) => `line ${i + 1}\n`).join('');
  const anchor = before.indexOf('line 64\n');
  for (const after of ['new\nnew again\n' + before, before.slice(before.indexOf('line 20\n'))]) {
    const mapped = mapTextOffset(anchor, textChanges(before, after));
    assert.equal(after.slice(mapped, mapped + 8), 'line 64\n');
  }
});

test('disjoint simultaneous changes are merged without dropping either user', () => {
  const before = 'int first = 1;\nint second = 2;\n';
  assert.equal(
    mergeText(before, before.replace('first', 'alpha'), before.replace('second', 'beta')),
    'int alpha = 1;\nint beta = 2;\n',
  );
  assert.equal(mergeText('abcde', 'aXXbcde', 'abcdYYe'), 'aXXbcdYYe');
  assert.equal(mergeText('ab', 'aXb', 'aYb'), 'aYXb');
});

test('acknowledging earlier submitted typing keeps every character entered while it was in flight', () => {
  const target = '// shared A draft';
  for (let submittedLength = 1; submittedLength < target.length; submittedLength++) {
    const submitted = target.slice(0, submittedLength);
    for (let typedLength = submittedLength; typedLength <= target.length; typedLength++) {
      const live = target.slice(0, typedLength);
      assert.equal(mergeText(submitted, live, submitted), live);
      assert.equal(
        mergeText('header\n' + submitted, 'header\n' + live, 'HEADER\n' + submitted),
        'HEADER\n' + live,
      );
    }
  }
});

test('overlapping replacement is a conflict rather than silent overwrite', () => {
  assert.equal(mergeText('hello world', 'hello local', 'hello remote'), null);
  assert.equal(mergeText('abcdef', 'abXef', 'abcYf'), null);
});

test('UTF16 offsets and CRLF roundtrip through minimal edits', () => {
  for (const [before, after] of [
    ['', 'x'],
    ['abc', ''],
    ['a\r\nb\r\n', 'a\r\nnew\r\nb\r\n'],
    ['😀 abc\n测试\n', '😀 XYZ\n测试\n尾部'],
    ['a\nb\nc\n', 'A\nb\nC\n'],
  ])
    assert.equal(applyTextChanges(before, textChanges(before, after)), after);
});

test('minimal changes reconstruct diverse deterministic documents', () => {
  let seed = 8721;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
  const alphabet = 'abcde\n\n';
  for (let attempt = 0; attempt < 250; attempt++) {
    const before = Array.from(
      { length: Math.floor(random() * 160) },
      () => alphabet[Math.floor(random() * alphabet.length)],
    ).join('');
    let after = before;
    for (let change = 0; change < 3; change++) {
      const start = Math.floor(random() * (after.length + 1)),
        end = Math.min(after.length, start + Math.floor(random() * 8));
      after = after.slice(0, start) + (random() > 0.5 ? 'new\ntext' : '') + after.slice(end);
    }
    assert.equal(applyTextChanges(before, textChanges(before, after)), after);
  }
});
