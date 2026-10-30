import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackageList } from '../src/renderer/components/PackageList';
test('large package review renders only a bounded visible window with accessible row totals', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => `file-${i}.h`);
  const markup = renderToStaticMarkup(
    createElement(PackageList, {
      items: rows,
      label: 'Dependencies',
      height: 240,
      rowHeight: 36,
      renderRow: (row: unknown) => String(row),
    }),
  );
  assert.ok((markup.match(/role="listitem"/g) ?? []).length <= 14);
  assert.match(markup, /aria-setsize="10000"/);
  assert.doesNotMatch(markup, /file-9999.h/);
});
