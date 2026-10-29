import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkspaceCloseGate,
  closeRecoveryKey,
  recoverCloseDrafts,
  type CloseDraftStorage,
} from '../src/renderer/workspace/workspaceCloseGate';

class StorageDouble implements CloseDraftStorage {
  data = new Map<string, string>();
  calls: string[] = [];
  failSet = '';
  failRemove = '';
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.calls.push(`set:${key}`);
    if (key === this.failSet) throw Error('quota');
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.calls.push(`remove:${key}`);
    if (key === this.failRemove) throw Error('storage blocked');
    this.data.delete(key);
  }
}
const key = 'blode.drafts:project';
function fixture() {
  let frozen = 0,
    released = 0;
  const gate = new WorkspaceCloseGate({
    freeze: () => {
      frozen++;
      return () => {
        released++;
      };
    },
  });
  return { gate, storage: new StorageDouble(), counts: () => ({ frozen, released }) };
}

test('close input freeze is synchronous and coalesces repeated ids; a newer id releases the old gate', () => {
  const f = fixture();
  f.gate.begin('one');
  assert.equal(f.gate.isFrozen(), true);
  assert.equal(f.gate.canApplySharedDrafts(), true);
  assert.equal(f.gate.canPersistDrafts('project'), true);
  f.gate.begin('one');
  assert.deepEqual(f.counts(), { frozen: 1, released: 0 });
  f.gate.begin('two');
  assert.deepEqual(f.counts(), { frozen: 2, released: 1 });
  f.gate.cancel('one');
  assert.equal(f.gate.isFrozen(), true);
  f.gate.cancel('two');
  assert.equal(f.gate.isFrozen(), false);
  assert.deepEqual(f.counts(), { frozen: 2, released: 2 });
});

test('discard backs up merged latest drafts before clearing only the selected project cache', () => {
  const f = fixture();
  f.storage.setItem(key, JSON.stringify({ 'cached.c': 'cached', 'same.c': 'old' }));
  f.storage.setItem('blode.drafts:other', '{"other.c":"keep"}');
  f.storage.calls = [];
  f.gate.begin('one');
  f.gate.commitDiscard('one', 'project', { 'same.c': 'new', 'main.c': 'typed' }, 'run-1', f.storage);
  assert.deepEqual(f.storage.calls, [`set:${closeRecoveryKey('project')}`, `remove:${key}`]);
  assert.equal(f.storage.getItem(key), null);
  assert.deepEqual(JSON.parse(f.storage.getItem(closeRecoveryKey('project'))!), {
    version: 1,
    requestId: 'one',
    lifecycleId: 'run-1',
    drafts: { 'cached.c': 'cached', 'same.c': 'new', 'main.c': 'typed' },
  });
  assert.equal(f.gate.canApplySharedDrafts(), false);
  assert.equal(f.gate.canPersistDrafts('project'), false);
  assert.equal(f.gate.canPersistDrafts('other'), true);
  f.gate.cancel('one');
  assert.deepEqual(JSON.parse(f.storage.getItem(key)!), {
    'cached.c': 'cached',
    'same.c': 'new',
    'main.c': 'typed',
  });
  assert.equal(f.storage.getItem(closeRecoveryKey('project')), null);
  assert.equal(f.storage.getItem('blode.drafts:other'), '{"other.c":"keep"}');
  assert.equal(f.gate.canApplySharedDrafts(), true);
});

test('backup failure leaves original drafts untouched and cannot activate the discard gate', () => {
  const f = fixture();
  f.storage.setItem(key, '{"main.c":"keep"}');
  f.storage.failSet = closeRecoveryKey('project');
  f.gate.begin('one');
  assert.throws(
    () => f.gate.commitDiscard('one', 'project', { 'main.c': 'new' }, 'run-1', f.storage),
    /quota/,
  );
  assert.equal(f.storage.getItem(key), '{"main.c":"keep"}');
  assert.equal(f.gate.canApplySharedDrafts(), true);
  assert.equal(f.gate.canPersistDrafts('project'), true);
  f.gate.cancel('one');
  assert.equal(f.gate.isFrozen(), false);
});

test('renderer recovery restores drafts for the same app run and keeps later cached user edits', () => {
  const f = fixture();
  f.gate.begin('one');
  f.gate.commitDiscard('one', 'project', { 'main.c': 'captured', 'other.c': 'retained' }, 'run-1', f.storage);
  f.storage.setItem(key, '{"main.c":"edited after cancellation"}');
  assert.deepEqual(recoverCloseDrafts('project', 'run-1', f.storage), {
    'main.c': 'edited after cancellation',
    'other.c': 'retained',
  });
  assert.equal(f.storage.getItem(closeRecoveryKey('project')), null);
  assert.equal(recoverCloseDrafts('project', 'run-1', f.storage), undefined);
  f.gate.cancel('one');
});

test('a new native app run discards recovery without restoring explicitly discarded changes', () => {
  const f = fixture();
  f.gate.begin('one');
  f.gate.commitDiscard('one', 'project', { 'main.c': 'discarded' }, 'run-1', f.storage);
  assert.equal(recoverCloseDrafts('project', 'run-2', f.storage), undefined);
  assert.equal(f.storage.getItem(closeRecoveryKey('project')), null);
  assert.equal(f.storage.getItem(key), null);
});

test('hot reload cleanup after commit releases DOM without resurrecting discarded draft storage', () => {
  const f = fixture();
  f.gate.begin('one');
  f.gate.commitDiscard('one', 'project', { 'main.c': 'discarded' }, 'run-1', f.storage);
  f.gate.detach('one');
  f.gate.detach('one');
  assert.deepEqual(f.counts(), { frozen: 1, released: 1 });
  assert.equal(f.gate.isFrozen(), true, 'the logical shutdown gate still blocks local setters');
  assert.equal(f.gate.canApplySharedDrafts(), false);
  assert.equal(f.gate.canPersistDrafts('project'), false);
  assert.equal(f.storage.getItem(key), null);
  assert.ok(f.storage.getItem(closeRecoveryKey('project')));
  recoverCloseDrafts('project', 'run-2', f.storage);
  assert.equal(
    f.storage.getItem(key),
    null,
    'a new application cannot restore a successfully discarded draft',
  );
});

test('the same close can reattach after hot reload and a later real cancellation restores its draft', () => {
  const f = fixture();
  f.gate.begin('one');
  f.gate.commitDiscard('one', 'project', { 'main.c': 'recoverable' }, 'run-1', f.storage);
  f.gate.detach('one');
  f.gate.begin('one');
  assert.deepEqual(f.counts(), { frozen: 2, released: 1 });
  assert.equal(f.storage.getItem(key), null);
  f.gate.cancel('one');
  assert.equal(f.gate.isFrozen(), false);
  assert.equal(f.gate.canPersistDrafts('project'), true);
  assert.deepEqual(JSON.parse(f.storage.getItem(key)!), { 'main.c': 'recoverable' });
  assert.equal(f.storage.getItem(closeRecoveryKey('project')), null);
  assert.deepEqual(f.counts(), { frozen: 2, released: 2 });
});

test('storage failures keep the durable backup but cancellation always releases input', () => {
  const f = fixture();
  f.gate.begin('one');
  f.gate.commitDiscard('one', 'project', { 'main.c': 'recoverable' }, 'run-1', f.storage);
  f.storage.failSet = key;
  assert.throws(() => f.gate.cancel('one'), /quota/);
  assert.equal(f.gate.isFrozen(), false);
  assert.equal(f.gate.canApplySharedDrafts(), true);
  assert.ok(f.storage.getItem(closeRecoveryKey('project')));
  assert.throws(() => recoverCloseDrafts('project', 'run-1', f.storage), /quota/);
  assert.ok(f.storage.getItem(closeRecoveryKey('project')));
  f.storage.failSet = '';
  assert.deepEqual(recoverCloseDrafts('project', 'run-1', f.storage), { 'main.c': 'recoverable' });
});

test('a newer close request remains frozen even if restoring the old cache fails', () => {
  const f = fixture();
  f.gate.begin('one');
  f.gate.commitDiscard('one', 'project', { 'main.c': 'recoverable' }, 'run-1', f.storage);
  f.storage.failSet = key;
  f.gate.begin('two');
  assert.equal(f.gate.isFrozen(), true);
  assert.deepEqual(f.counts(), { frozen: 2, released: 1 });
  assert.ok(f.storage.getItem(closeRecoveryKey('project')));
  assert.throws(() => f.gate.commitDiscard('one', 'project', {}, 'run-1', f.storage), /closeRequestExpired/);
  f.gate.cancel('two');
});

test('DOM gate makes the workspace inert synchronously, permits the close dialog, and restores prior attributes', () => {
  class ElementDouble {
    children: ElementDouble[] = [];
    parent?: ElementDouble;
    attributes = new Map<string, string>();
    constructor(readonly closeDialog = false) {}
    matches(selector: string) {
      return selector === '.app-close-dialog' && this.closeDialog;
    }
    querySelector(selector: string): ElementDouble | undefined {
      return (
        this.children.find((child) => child.matches(selector)) ??
        this.children.flatMap((child) => child.querySelector(selector) ?? []).at(0)
      );
    }
    closest(selector: string): ElementDouble | null {
      return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
    }
    getAttribute(key: string) {
      return this.attributes.get(key) ?? null;
    }
    setAttribute(key: string, value: string) {
      this.attributes.set(key, value);
    }
    removeAttribute(key: string) {
      this.attributes.delete(key);
    }
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  const root = new ElementDouble(),
    preexisting = new ElementDouble();
  preexisting.setAttribute('inert', 'existing');
  const body = new ElementDouble();
  body.children = [root, preexisting];
  const listeners = new Map<string, (event: Event) => void>();
  let changed: () => void = () => {},
    disconnected = false;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body,
      addEventListener: (name: string, listener: (event: Event) => void, capture: boolean) => {
        assert.equal(capture, true);
        listeners.set(name, listener);
      },
      removeEventListener: (name: string) => {
        listeners.delete(name);
      },
    },
  });
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        changed = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  });
  const gate = new WorkspaceCloseGate();
  try {
    gate.begin('one');
    assert.equal(root.getAttribute('inert'), '');
    const dialog = new ElementDouble(true);
    body.children.push(dialog);
    changed();
    assert.equal(dialog.getAttribute('inert'), null);
    const edit = new Event('beforeinput', { cancelable: true });
    Object.defineProperty(edit, 'composedPath', { value: () => [root, body] });
    listeners.get('beforeinput')!(edit);
    assert.equal(edit.defaultPrevented, true);
    const button = new ElementDouble();
    button.parent = dialog;
    const click = new Event('click', { cancelable: true });
    Object.defineProperty(click, 'composedPath', { value: () => [button, dialog, body] });
    listeners.get('click')!(click);
    assert.equal(click.defaultPrevented, false);
    gate.cancel('one');
    assert.equal(root.getAttribute('inert'), null);
    assert.equal(preexisting.getAttribute('inert'), 'existing');
    assert.equal(listeners.size, 0);
    assert.equal(disconnected, true);
  } finally {
    gate.cancel('one');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousObserver) Object.defineProperty(globalThis, 'MutationObserver', previousObserver);
    else Reflect.deleteProperty(globalThis, 'MutationObserver');
  }
});
