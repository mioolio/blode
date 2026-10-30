import test from 'node:test';
import assert from 'node:assert/strict';
import { ownsEditorNavigation } from '../src/renderer/editor/navigationOwner';

test('direct and embedded Peek navigation belongs to exactly one registered split pane', () => {
  const one = {},
    two = {},
    registered = new WeakSet<object>([one, two]);
  const peek = { getParentEditor: () => one },
    nested = { getParentEditor: () => peek };
  assert.equal(ownsEditorNavigation(one, one, registered), true);
  assert.equal(ownsEditorNavigation(one, two, registered), false);
  assert.equal(ownsEditorNavigation(peek, one, registered), true);
  assert.equal(ownsEditorNavigation(nested, one, registered), true);
  assert.equal(
    ownsEditorNavigation(nested, two, registered),
    false,
    'another focused pane cannot claim the old Peek',
  );
  assert.equal(ownsEditorNavigation({ getParentEditor: () => two }, two, registered), true);
});

test('unrelated, disposed or cyclic embedded editors cannot dispatch navigation into a pane', () => {
  const owner = {},
    registered = new WeakSet<object>([owner]);
  const cyclic = { getParentEditor: (): object => cyclic };
  assert.equal(ownsEditorNavigation({}, owner, registered), false);
  assert.equal(ownsEditorNavigation(cyclic, owner, registered), false);
  assert.equal(
    ownsEditorNavigation(
      {
        getParentEditor: () => {
          throw Error('disposed');
        },
      },
      owner,
      registered,
    ),
    false,
  );
});
