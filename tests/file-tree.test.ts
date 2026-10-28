import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileTree, type FileTreeEntry } from '../src/renderer/workspace/fileTree';

const file = (path: string, size = 10, editable = true): FileTreeEntry => ({
  path,
  kind: 'file',
  size,
  editable,
});
const directory = (path: string): FileTreeEntry => ({ path, kind: 'directory', size: 0, editable: false });

describe('workspace file tree', () => {
  it('keeps same-basename files under distinct nested directories', () => {
    const tree = buildFileTree([
      file('src/device/config.h', 41),
      file('src/network/config.h', 72),
      file('main.ino', 13),
    ]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ['src', 'main.ino'],
    );
    const children = tree[0].children;
    assert.deepEqual(
      children.map((node) => node.name),
      ['device', 'network'],
    );
    assert.equal(children[0].children[0].path, 'src/device/config.h');
    assert.equal(children[1].children[0].path, 'src/network/config.h');
    assert.equal(children[0].children[0].size, 41);
    assert.equal(children[1].children[0].size, 72);
  });
  it('preserves real empty folders and hides no binary inventory files', () => {
    const tree = buildFileTree([directory('empty'), file('firmware.bin', 65536, false)]);
    assert.deepEqual(tree[0], {
      path: 'empty',
      name: 'empty',
      kind: 'directory',
      size: 0,
      editable: false,
      children: [],
    });
    assert.equal(tree[1].editable, false);
    assert.equal(tree[1].size, 65536);
  });
  it('preserves case and independently keys directories and files', () => {
    const tree = buildFileTree([
      file('Config.h'),
      file('config.h'),
      directory('modules'),
      file('modules'),
      file('modules/Sensor.h'),
      file('Modules/sensor.h'),
    ]);
    assert.equal(tree.filter((node) => node.name === 'modules').length, 2);
    assert.equal(
      tree.find((node) => node.name === 'modules' && node.kind === 'directory')!.children[0].path,
      'modules/Sensor.h',
    );
    assert.equal(tree.find((node) => node.name === 'Modules')!.children[0].path, 'Modules/sensor.h');
    assert.ok(tree.some((node) => node.name === 'Config.h'));
    assert.ok(tree.some((node) => node.name === 'config.h'));
  });
  it('accepts child-first input without duplicate parents and never mutates inventory', () => {
    const entries = Object.freeze([
      Object.freeze(file('src\\sensors\\reader.cpp', 128)),
      Object.freeze(directory('src/sensors')),
      Object.freeze(directory('src')),
    ]);
    const tree = buildFileTree(entries);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].children[0].children[0].path, 'src/sensors/reader.cpp');
    assert.equal(entries[0].path, 'src\\sensors\\reader.cpp');
  });
  it('sorts folders first and numeric filenames naturally', () => {
    const tree = buildFileTree([file('file10.cpp'), file('file2.cpp'), directory('z'), file('a.cpp')]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ['z', 'a.cpp', 'file2.cpp', 'file10.cpp'],
    );
  });
  it('does not create nodes for path traversal or absolute paths', () => {
    const tree = buildFileTree([
      file('../outside.txt'),
      file('a/../outside.txt'),
      file('/etc/file'),
      file('C:\\windows\\file'),
      file('ok.cpp'),
    ]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ['ok.cpp'],
    );
  });
});
