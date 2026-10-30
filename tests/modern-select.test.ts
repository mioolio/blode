import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModernSelect, selectOptions } from '../src/renderer/components/ModernSelect';
import { filterSelectOptions, selectNavigation } from '../src/renderer/components/modernSelectModel';

test('selector search matches words across labels and groups while retaining stable values', () => {
  const options = selectOptions([
    createElement(
      'optgroup',
      { key: 'gnu', label: 'GNU Arm GCC' },
      createElement('option', { value: 'gcc13' }, '13.3.1'),
      createElement('option', { value: 'gcc15', disabled: true }, '15.2.1'),
    ),
    createElement(
      'optgroup',
      { key: 'ac6', label: 'Arm Compiler', disabled: true },
      createElement('option', { value: 'ac6' }, '6.22'),
    ),
  ]);
  assert.deepEqual(
    filterSelectOptions(options, 'GNU 13').map(({ value }) => value),
    ['gcc13'],
  );
  assert.deepEqual(
    filterSelectOptions(options, 'ARM').map(({ value }) => value),
    ['gcc13', 'gcc15', 'ac6'],
  );
  assert.deepEqual(filterSelectOptions(options, 'no tool'), []);
  assert.equal(options[2].disabled, true);
});

test('keyboard traversal skips disabled tools and wraps without selecting an unavailable option', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'blocked', label: 'Blocked', disabled: true },
    { value: 'c', label: 'C' },
  ];
  assert.equal(selectNavigation(options, -1, 'ArrowDown'), 0);
  assert.equal(selectNavigation(options, -1, 'ArrowUp'), 2);
  assert.equal(selectNavigation(options, 0, 'ArrowDown'), 2);
  assert.equal(selectNavigation(options, 2, 'ArrowDown'), 0);
  assert.equal(selectNavigation(options, 0, 'ArrowUp'), 2);
  assert.equal(selectNavigation(options, 2, 'Home'), 0);
  assert.equal(selectNavigation(options, 0, 'End'), 2);
  assert.equal(
    selectNavigation(
      options.map((option) => ({ ...option, disabled: true })),
      0,
      'Home',
    ),
    -1,
  );
});

test('selector preserves native form value and disabled semantics without rendering a popup during SSR', () => {
  const html = renderToStaticMarkup(
    createElement(
      ModernSelect,
      { name: 'runtime', value: 'usb', disabled: true, 'aria-label': 'Runtime' },
      createElement('option', { value: 'usb' }, 'USB <script>'),
      createElement('option', { value: 'serial' }, 'Serial'),
    ),
  );
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /name="runtime"/);
  assert.match(html, /<option value="usb" selected="">USB &lt;script&gt;/);
  assert.match(html, /modern-select-trigger[^>]*disabled=""/);
  assert.doesNotMatch(html, /role="listbox"|<script>/);
});
