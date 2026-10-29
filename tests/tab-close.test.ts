import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FileCloseQueue,
  prepareFileClose,
  registerFileCloseHandler,
  type FileCloseDecision,
  type FileClosePrompt,
  type FileCloseSnapshot,
} from '../src/renderer/workspace/fileClose';
import { FileCloseDialog } from '../src/renderer/components/FileCloseDialog';
import type { Studio } from '../src/renderer/workspace/useStudio';

function fixture() {
  const files = new Map<string, FileCloseSnapshot>([
    ['one.c', { root: '/workspace', path: 'one.c', content: 'changed', dirty: true }],
    ['two.c', { root: '/workspace', path: 'two.c', content: 'another', dirty: true }],
    ['read.c', { root: '/workspace', path: 'read.c', content: 'clean', dirty: false }],
  ]);
  let prompt: FileClosePrompt | null = null;
  const prepared: [string, FileCloseDecision][] = [];
  const closed: string[] = [],
    errors: unknown[] = [];
  let prepare = async (_snapshot: FileCloseSnapshot, _decision: FileCloseDecision) => {};
  const queue = new FileCloseQueue({
    snapshot: (path) => {
      const file = files.get(path);
      return file ? { ...file } : undefined;
    },
    prepare: async (snapshot, decision) => {
      prepared.push([snapshot.path, decision]);
      await prepare(snapshot, decision);
    },
    close: (snapshot) => {
      closed.push(snapshot.path);
      files.delete(snapshot.path);
    },
    prompt: (value) => {
      prompt = value;
    },
    failed: (error) => {
      errors.push(error);
    },
  });
  return {
    queue,
    files,
    prepared,
    closed,
    errors,
    get prompt() {
      return prompt;
    },
    setPrepare: (value: typeof prepare) => {
      prepare = value;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('dirty close waits for one of three choices; cancel leaves every draft and tab intact', async () => {
  const view = fixture(),
    closing = view.queue.request('one.c');
  assert.equal(view.prompt?.path, 'one.c');
  assert.equal(view.prompt?.busy, false);
  assert.deepEqual(view.prepared, []);
  await view.queue.choose('cancel');
  assert.equal(await closing, false);
  assert.equal(view.files.get('one.c')?.content, 'changed');
  assert.deepEqual(view.closed, []);
});

test('save close prepares only the chosen file, while discard and clean close never request a save', async () => {
  const view = fixture();
  const save = view.queue.request('one.c');
  await view.queue.choose('save');
  assert.equal(await save, true);
  assert.deepEqual(view.prepared, [['one.c', 'save']]);
  assert.ok(view.files.has('two.c'));
  const discard = view.queue.request('two.c');
  await view.queue.choose('discard');
  assert.equal(await discard, true);
  assert.equal(await view.queue.request('read.c'), true);
  assert.deepEqual(view.prepared, [
    ['one.c', 'save'],
    ['two.c', 'discard'],
    ['read.c', 'release'],
  ]);
  assert.deepEqual(view.closed, ['one.c', 'two.c', 'read.c']);
});

test('repeat close clicks share one answer and closing another file queues rather than replacing the prompt', async () => {
  const view = fixture(),
    first = view.queue.request('one.c');
  assert.equal(view.queue.request('one.c'), first);
  const second = view.queue.request('two.c');
  assert.equal(view.prompt?.path, 'one.c');
  await view.queue.choose('cancel');
  assert.equal(await first, false);
  assert.equal(view.prompt?.path, 'two.c');
  await view.queue.choose('discard');
  assert.equal(await second, true);
  assert.deepEqual(view.closed, ['two.c']);
});

test('failed save keeps the file and confirmation available for retry or cancel', async () => {
  const view = fixture(),
    closing = view.queue.request('one.c');
  view.setPrepare(async () => {
    throw new Error('disk unavailable');
  });
  await view.queue.choose('save');
  assert.deepEqual(view.closed, []);
  assert.equal(view.prompt?.error, 'disk unavailable');
  assert.equal(view.prompt?.busy, false);
  assert.equal(view.errors.length, 1);
  view.setPrepare(async () => {});
  await view.queue.choose('save');
  assert.equal(await closing, true);
  assert.deepEqual(view.closed, ['one.c']);
});

test('typing or a remote edit during save is preserved and requires another close decision', async () => {
  const view = fixture(),
    write = deferred(),
    closing = view.queue.request('one.c');
  view.setPrepare(() => write.promise);
  const saving = view.queue.choose('save');
  assert.equal(view.prompt?.busy, true);
  await view.queue.choose('cancel'); // An in-flight save cannot be replaced by a different decision.
  view.files.get('one.c')!.content = 'changed again';
  write.resolve();
  await saving;
  assert.equal(view.prompt?.error, 'dialog.closeFileChanged');
  assert.equal(view.files.get('one.c')?.content, 'changed again');
  assert.deepEqual(view.closed, []);
  await view.queue.choose('cancel');
  assert.equal(await closing, false);
});

test('a newly dirty clean tab is not silently discarded during asynchronous release', async () => {
  const view = fixture(),
    release = deferred();
  view.setPrepare(() => release.promise);
  const closing = view.queue.request('read.c');
  view.files.get('read.c')!.dirty = true;
  release.resolve();
  await release.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(view.closed, []);
  assert.equal(view.prompt?.path, 'read.c');
  assert.equal(view.prompt?.error, 'dialog.closeFileChanged');
  await view.queue.choose('cancel');
  assert.equal(await closing, false);
});

test('changing workspaces cancels unanswered closes and a late operation cannot close the new workspace', async () => {
  const view = fixture(),
    write = deferred(),
    closing = view.queue.request('one.c');
  const queued = view.queue.request('two.c');
  view.setPrepare(() => write.promise);
  const operation = view.queue.choose('save');
  view.queue.reset();
  view.files.get('one.c')!.root = '/other-workspace';
  assert.equal(await closing, false);
  assert.equal(await queued, false);
  write.resolve();
  await operation;
  assert.deepEqual(view.closed, []);
  assert.equal(view.prompt, null);
});

test('a remote-only clean tab can be released without a local pinned-tab membership check', async () => {
  const view = fixture();
  assert.equal(await view.queue.request('read.c'), true);
  assert.deepEqual(view.closed, ['read.c']);
  assert.equal(await view.queue.request('missing.c'), false);
});

test('file-close registrations are root-aware and cleanup removes their effects', async () => {
  const calls: string[] = [];
  const remove = registerFileCloseHandler(async (root, path, decision) => {
    if (root !== '/workspace') return false;
    calls.push(`${path}:${decision}`);
    return true;
  });
  try {
    assert.equal(await prepareFileClose('/elsewhere', 'one.c', 'save'), false);
    assert.equal(await prepareFileClose('/workspace', 'one.c', 'save'), true);
    assert.deepEqual(calls, ['one.c:save']);
  } finally {
    remove();
  }
  assert.equal(await prepareFileClose('/workspace', 'one.c', 'discard'), false);
  assert.deepEqual(calls, ['one.c:save']);
});

test('close dialog exposes save, discard and cancel, with shared-edit preservation explained', () => {
  const html = renderToStaticMarkup(
    createElement(FileCloseDialog, {
      studio: {
        t: (value: string) => value,
        closeFilePrompt: { root: '/workspace', path: 'one.c', busy: false },
        chooseFileClose: async () => {},
        syncDrafts: true,
      } as unknown as Studio,
    }),
  );
  assert.match(html, /role="alertdialog"/);
  for (const label of [
    'dialog.closeFileSave',
    'dialog.closeFileDiscard',
    'action.cancel',
    'dialog.closeFileSharedNote',
  ])
    assert.ok(html.includes(label));
  assert.match(html, /one\.c/);
});
