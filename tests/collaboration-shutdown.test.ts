import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationService } from '../src/core/collaboration';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
async function fixture(onSave?: (content: string) => Promise<void>) {
  const workspace = { projectRoot: '/shutdown', files: [{ path: 'main.c', content: 'original' }] };
  let writes = 0;
  const service = new CollaborationService({
    workspace: async () => structuredClone(workspace),
    publish: () => {},
    saveFile: async (path, content) => {
      writes++;
      await onSave?.(content);
      workspace.files.find((file) => file.path === path)!.content = content;
    },
  });
  const doc = await service.open('/shutdown', 'main.c');
  const edit = (id: string, revision: number, text: string) =>
    service.edit(
      {
        projectRoot: '/shutdown',
        session: doc.session,
        path: 'main.c',
        peerId: 'browser',
        actorToken: 'b'.repeat(64),
        requestId: id,
        baseRevision: revision,
        changes: [{ start: 0, end: 0, text }],
      },
      false,
    );
  return { service, workspace, edit, doc, writes: () => writes };
}

test('saving for shutdown serializes all shared drafts and rejects an edit queued behind the final flush', async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(async () => {
    entered.resolve();
    await release.promise;
  });
  t.after(() => f.service.dispose());
  const changed = await f.edit('first', 0, 'draft ');
  const preparing = f.service.prepareShutdown('saved');
  await entered.promise;
  const queued = f.edit('after-flush', changed.document.revision, 'racing ');
  const rejected = assert.rejects(queued, /shutdownInProgress/);
  release.resolve();
  const closed = await preparing;
  await rejected;
  assert.equal(f.workspace.files[0].content, 'draft original');
  assert.equal(closed.documents[0].dirty, false);
  assert.equal(f.writes(), 1);
  await f.service.cancelShutdown();
  assert.equal((await f.edit('after-flush', changed.document.revision, 'racing ')).status, 'applied');
});

test('clean shutdown discovers a concurrent dirty draft and discard never persists it', async (t) => {
  const f = await fixture();
  t.after(() => f.service.dispose());
  let doc = (await f.edit('draft', 0, 'unsaved ')).document;
  await assert.rejects(f.service.prepareShutdown('clean'), /unsavedChanges/);
  doc = (await f.edit('still-editable', doc.revision, 'more ')).document;
  await f.service.prepareShutdown('discard');
  assert.equal(f.writes(), 0);
  assert.equal(f.workspace.files[0].content, 'original');
  await assert.rejects(f.service.flush(), /shutdownInProgress/);
  await assert.rejects(
    f.service.save({
      projectRoot: '/shutdown',
      session: doc.session,
      path: doc.path,
      revision: doc.revision,
    }),
    /shutdownInProgress/,
  );
  await assert.rejects(f.service.writeFile('/shutdown', 'main.c', doc.content), /shutdownInProgress/);
  await assert.rejects(
    f.service.resolve({
      projectRoot: '/shutdown',
      session: doc.session,
      path: doc.path,
      revision: doc.revision,
      content: 'resolved',
      diskContent: 'original',
    }),
    /shutdownInProgress/,
  );
  await assert.rejects(
    f.service.undo(
      {
        projectRoot: '/shutdown',
        session: doc.session,
        path: doc.path,
        peerId: 'browser',
        actorToken: 'b'.repeat(64),
        requestId: 'undo-closing',
        direction: 'undo',
      },
      false,
    ),
    /shutdownInProgress/,
  );
  let moved = false;
  await assert.rejects(
    f.service.workspaceAction(async () => {
      moved = true;
    }),
    /shutdownInProgress/,
  );
  assert.equal(moved, false);
  assert.equal(
    (await f.service.state()).documents[0].dirty,
    true,
    'discard leaves shared text available if closing is cancelled',
  );
  await f.service.cancelShutdown();
  assert.equal((await f.edit('after-cancel', doc.revision, 'resumed ')).status, 'applied');
});

test('failed shutdown persistence unfreezes editing and clean success has no post-check write gap', async (t) => {
  const f = await fixture(async () => {
    throw new Error('disk unavailable');
  });
  t.after(() => f.service.dispose());
  const doc = (await f.edit('draft', 0, 'draft ')).document;
  await assert.rejects(f.service.prepareShutdown('saved'), /disk unavailable/);
  assert.equal((await f.edit('retry-work', doc.revision, 'local ')).status, 'applied');
  const empty = await fixture();
  t.after(() => empty.service.dispose());
  await empty.service.prepareShutdown('clean');
  await assert.rejects(empty.edit('racing-after-clean', 0, 'late '), /shutdownInProgress/);
  assert.equal(empty.writes(), 0);
  await empty.service.cancelShutdown();
  assert.equal((await empty.edit('racing-after-clean', 0, 'late ')).status, 'applied');
});
