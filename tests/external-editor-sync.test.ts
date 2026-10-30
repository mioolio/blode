import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CollaborationService, type CollaborationWorkspace } from '../src/core/collaboration';
import type { CollaborationEvent } from '../src/shared/collaboration';
import { readProjectFiles, watchWorkspace } from '../src/core/workspace';
import { SnapshotCache } from '../src/core/snapshot-cache';

test('external editor atomic saves refresh clean shared code and retain conflicting unsaved drafts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-external-editor-'));
  const cache = new SnapshotCache<CollaborationWorkspace>();
  const events: CollaborationEvent[] = [];
  const read = async () => ({ projectRoot: root, files: await readProjectFiles(root) });
  const service = new CollaborationService({
    workspace: () => cache.get(root, read),
    freshWorkspace: read,
    publish: (event) => events.push(event),
    saveFile: async (file, content) => {
      await fs.writeFile(path.join(root, file), content);
      cache.invalidate();
    },
  });
  let onChange: (() => void) | undefined;
  let stop = () => {};
  try {
    await fs.writeFile(path.join(root, 'main.c'), 'int original;\n');
    const initial = await service.open(root, 'main.c');
    stop = watchWorkspace(root, () => {
      cache.invalidate();
      onChange?.();
    });
    const externalSave = async (content: string) => {
      let timer: ReturnType<typeof setTimeout>;
      const changed = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('external save was not observed')), 4000);
        onChange = () => {
          clearTimeout(timer);
          onChange = undefined;
          resolve();
        };
      });
      try {
        await fs.writeFile(path.join(root, 'main.c.save'), content);
        await fs.rename(path.join(root, 'main.c.save'), path.join(root, 'main.c'));
        await changed;
      } finally {
        clearTimeout(timer!);
        onChange = undefined;
      }
      return service.state();
    };
    const clean = await externalSave('int from_vscode;\n');
    const doc = await service.open(root, 'main.c');
    assert.equal(doc.content, 'int from_vscode;\n');
    assert.ok(clean.documents[0]!.revision > initial.revision);
    await service.edit({
      projectRoot: root,
      session: doc.session,
      path: doc.path,
      peerId: 'reader',
      requestId: 'local-draft',
      baseRevision: doc.revision,
      changes: [{ start: 0, end: 0, text: '// local draft\n' }],
    });
    events.length = 0;
    const conflict = await externalSave('int separately_saved;\n');
    assert.equal((await service.open(root, 'main.c')).content, '// local draft\nint from_vscode;\n');
    assert.equal(conflict.documents[0]!.dirty, true);
    const notification = events.find((event) => event.type === 'conflict');
    assert.ok(notification?.type === 'conflict');
    assert.equal(notification.reason, 'diskChanged');
    assert.equal(notification.diskContent, 'int separately_saved;\n');
    assert.equal(await fs.readFile(path.join(root, 'main.c'), 'utf8'), 'int separately_saved;\n');
  } finally {
    stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
