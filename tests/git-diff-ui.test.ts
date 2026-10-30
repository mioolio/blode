import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitDiff, unifiedDiffRows } from '../src/renderer/components/GitDiff';

test('unified diffs keep deleted and added line numbers on the correct sides across files', () => {
  const rows = unifiedDiffRows(
    'diff --git a/a.c b/a.c\n--- a/a.c\n+++ b/a.c\n@@ -5,2 +5,2 @@\n same\n-previous\n+current\n\\ No newline at end of file\ndiff --git a/b.c b/b.c\n--- /dev/null\n+++ b/b.c\n@@ -0,0 +1 @@\n+new',
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === 'context').map((row) => [row.before, row.after]),
    [[5, 5]],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === 'removed').map((row) => [row.before, row.after]),
    [[6, undefined]],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === 'added').map((row) => [row.before, row.after]),
    [
      [undefined, 6],
      [undefined, 1],
    ],
  );
  assert.equal(rows.find((row) => row.text.startsWith('\\'))?.kind, 'meta');
  assert.ok(rows.filter((row) => row.text.startsWith('+++')).every((row) => row.kind === 'meta'));
});

test('large diff previews mount a bounded viewport while preserving total scroll height', () => {
  const value =
    '@@ -1,1 +1,10000 @@\n' + Array.from({ length: 10000 }, (_, n) => `+line ${n + 1}`).join('\n');
  const html = renderToStaticMarkup(createElement(GitDiff, { value }));
  assert.match(html, /height:200020px/);
  assert.ok((html.match(/class="git-diff-line/g) ?? []).length < 50);
  assert.match(html, /line 1/);
  assert.doesNotMatch(html, /line 10000/);
});
