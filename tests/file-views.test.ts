import test from 'node:test';
import assert from 'node:assert/strict';
import { openableFilePaths, workspaceFileView } from '../src/shared/file-views';
import { persistentFiles, pinFileTab, previewFile } from '../src/renderer/workspace/tabs';
import { visibleFilePaths } from '../src/renderer/workspace/remoteTabs';

const workspace = {
  files: [{ path: 'src/main.c' }, { path: 'icon.svg' }],
  inventory: {
    entries: [
      { path: 'src', kind: 'directory' as const },
      { path: 'src/main.c', kind: 'file' as const },
      { path: 'cover.png', kind: 'file' as const },
      { path: 'sound.mp3', kind: 'file' as const },
      { path: 'firmware.bin', kind: 'file' as const },
      { path: 'large.txt', kind: 'file' as const },
    ],
  },
};

test('file views include disk resources without adding content to the text snapshot', () => {
  assert.deepEqual(openableFilePaths(workspace), [
    'src/main.c',
    'icon.svg',
    'cover.png',
    'sound.mp3',
    'firmware.bin',
    'large.txt',
  ]);
  assert.equal(workspaceFileView(workspace, 'src/main.c'), 'text');
  assert.equal(workspaceFileView(workspace, 'icon.svg'), 'text', 'existing text sources remain editable');
  for (const path of ['cover.png', 'sound.mp3', 'firmware.bin', 'large.txt'])
    assert.equal(workspaceFileView(workspace, path), 'asset', path);
  for (const path of ['src', 'missing.png', '']) assert.equal(workspaceFileView(workspace, path), undefined);
  assert.equal(workspace.files.length, 2);
});

test('resource tabs share preview replacement, pinning, remote suggestions and deletion cleanup', () => {
  let tabs = previewFile({ files: [], preview: '' }, 'cover.png');
  tabs = previewFile(tabs, 'sound.mp3');
  assert.deepEqual(tabs.files, ['sound.mp3']);
  tabs = pinFileTab(tabs, 'sound.mp3');
  tabs = previewFile(tabs, 'firmware.bin');
  assert.deepEqual(persistentFiles(tabs), ['sound.mp3']);
  assert.deepEqual(visibleFilePaths(tabs.files, ['cover.png'], new Set()), [
    'sound.mp3',
    'firmware.bin',
    'cover.png',
  ]);
  const afterDelete = new Set(
    openableFilePaths({
      ...workspace,
      inventory: { entries: workspace.inventory.entries.filter((entry) => entry.path !== 'sound.mp3') },
    }),
  );
  assert.deepEqual(
    tabs.files.filter((path) => afterDelete.has(path)),
    ['firmware.bin'],
  );
});

test('source-only or missing snapshots remain compatible', () => {
  assert.deepEqual(openableFilePaths(null), []);
  assert.deepEqual(openableFilePaths({ files: [{ path: 'main.c' }] }), ['main.c']);
  assert.equal(workspaceFileView(undefined, 'a.png'), undefined);
});
