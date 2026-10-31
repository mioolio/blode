import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { ExplorerStateStore } from '../src/core/explorer-state';

const inventory = {
  entries: [
    { path: 'Hardware', kind: 'directory', size: 0, editable: false },
    { path: 'Library', kind: 'directory', size: 0, editable: false },
    { path: 'Library/CMSIS', kind: 'directory', size: 0, editable: false },
    { path: 'System', kind: 'directory', size: 0, editable: false },
    { path: 'User', kind: 'directory', size: 0, editable: false },
    { path: 'User/main.c', kind: 'file', size: 10, editable: true },
  ],
  totalBytes: 10,
  fileCount: 1,
  directoryCount: 5,
  truncated: false,
};

function store(root: string) {
  return new ExplorerStateStore({
    currentProjectRoot: () => root,
    workspaceSnapshot: async () => ({ projectRoot: root, inventory }) as any,
  });
}

test('explorer state persists collapsed folders in .blode and reloads them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-explorer-'));
  try {
    await mkdir(path.join(root, '.blode'), { recursive: true });
    const first = store(root);
    assert.deepEqual(await first.state(), { version: 1, collapsed: [], rootCollapsed: false });
    await first.save(root, {
      version: 1,
      collapsed: ['System', 'Library/CMSIS', 'Hardware'],
      rootCollapsed: true,
    });
    const saved = JSON.parse(await readFile(path.join(root, '.blode/explorer.json'), 'utf8'));
    assert.deepEqual(saved, {
      version: 1,
      collapsed: ['Hardware', 'Library/CMSIS', 'System'],
      rootCollapsed: true,
    });
    // A new host/store instance represents the next application launch.
    assert.deepEqual(await store(root).state(), {
      version: 1,
      collapsed: ['Hardware', 'Library/CMSIS', 'System'],
      rootCollapsed: true,
    });
    assert.deepEqual(
      (await readdir(path.join(root, '.blode'))).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explorer state drops deleted or unsafe folders and tolerates corrupt files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-explorer-'));
  try {
    const value = store(root);
    await value.save(root, {
      version: 1,
      collapsed: ['Library/CMSIS', 'DeletedFolder', '../escape', 'User/main.c'],
      rootCollapsed: false,
    });
    assert.deepEqual((await value.state()).collapsed, ['Library/CMSIS']);

    await writeFile(path.join(root, '.blode/explorer.json'), '{broken', 'utf8');
    assert.deepEqual(await value.state(), { version: 1, collapsed: [], rootCollapsed: false });

    await writeFile(
      path.join(root, '.blode/explorer.json'),
      JSON.stringify({ version: 2, collapsed: ['System'], rootCollapsed: true }),
      'utf8',
    );
    assert.deepEqual(await value.state(), { version: 1, collapsed: [], rootCollapsed: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explorer state refuses to write after the project changed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-explorer-'));
  try {
    const value = store(root);
    await assert.rejects(
      value.save(path.join(root, 'other'), {
        version: 1,
        collapsed: [],
        rootCollapsed: false,
      }),
      /error\.collaborationProjectChanged/,
    );
    assert.deepEqual(await value.state(), { version: 1, collapsed: [], rootCollapsed: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
