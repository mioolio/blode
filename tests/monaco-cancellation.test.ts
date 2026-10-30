import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { monacoHighlightCancellation } from '../scripts/monaco-highlights';
test('word-highlighter delayed promises observe cancellation at their source, leaving other errors visible', async () => {
  const id = 'node_modules/monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
  const code = await readFile(id, 'utf8');
  const result = monacoHighlightCancellation().transform(code, '/project/' + id);
  assert.ok(result);
  assert.equal((result.code.match(/\.catch\(onUnexpectedError\)/g) ?? []).length, 3);
  assert.ok(result.code.includes('import { onUnexpectedError, onUnexpectedExternalError }'));
  assert.equal(monacoHighlightCancellation().transform(code, '/application/wordHighlighter.js'), undefined);
  assert.throws(
    () => monacoHighlightCancellation().transform('this.runDelayer.trigger(unknown);', '/project/' + id),
    /review its cancellation/,
  );
});

test('observable async callbacks report real errors while cancelled inline suggestions settle normally', async () => {
  const id = 'node_modules/monaco-editor/esm/vs/base/common/observableInternal/utils/runOnChange.js';
  const code = await readFile(id, 'utf8');
  const result = monacoHighlightCancellation().transform(code, '/project/' + id);
  assert.ok(result);
  assert.equal(
    (result.code.match(/Promise.resolve\(blodeResult\).catch\(onUnexpectedError\)/g) ?? []).length,
    3,
  );
  assert.ok(result.code.startsWith("import { onUnexpectedError } from '../../errors.js';"));
  assert.ok(
    result.code.includes("typeof blodeResult.then === 'function'"),
    'synchronous callbacks do not allocate promise work',
  );
  assert.throws(
    () => monacoHighlightCancellation().transform('cb(changed)', '/project/' + id),
    /review their cancellation/,
  );
});
