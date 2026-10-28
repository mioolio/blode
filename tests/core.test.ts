import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePartitions, toPartitionCsv } from '../extensions/boards/esp32-s3/layout';
import { parseConfig } from '../src/core/config';
import {
  safeWorkspacePath,
  writeProjectFile,
  loadProjectConfig,
  loadProjectDescriptor,
  persistConfig,
  readProjectFiles,
  scanProjectInventory,
  watchWorkspace,
} from '../src/core/workspace';
import { createCore } from '../src/core/service';
import { parseBuildOutput } from '../extensions/boards/esp32-s3/runtime';
import { loadBuildState } from '../src/core/build-state';
import { esp32S3Adapter } from '../extensions/boards/esp32-s3/adapter';
import { stm32Adapter } from '../extensions/boards/stm32/adapter';
import { runCommand } from '../src/core/process';

test('partition validation rejects overlap, bounds and misaligned app addresses', () => {
  const config = esp32S3Adapter.createConfig();
  assert.doesNotThrow(() => validatePartitions(config.partitions, config.flashSize));
  assert.throws(
    () =>
      validatePartitions(
        [...config.partitions, { id: 'bad', name: 'bad', type: 'data', offset: 0x10000, size: 0x1000 }],
        config.flashSize,
      ),
    /partitionOverlap/,
  );
  assert.throws(
    () =>
      validatePartitions(
        [{ id: 'app', name: 'app', type: 'app', offset: 0x11000, size: 0x10000 }],
        config.flashSize,
      ),
    /appAlignment/,
  );
  assert.throws(
    () =>
      validatePartitions(
        [{ id: 'app', name: 'app', type: 'app', offset: 0x10000, size: config.flashSize }],
        config.flashSize,
      ),
    /partitionBounds/,
  );
});

test('partition CSV omits bootloader and maps factory, PHY and NVS correctly', () => {
  const csv = toPartitionCsv(esp32S3Adapter.createConfig().partitions);
  assert.match(csv, /factory,app,factory,0x10000/);
  assert.match(csv, /phy_init,data,phy,/);
  assert.match(csv, /nvs,data,nvs,/);
  assert.match(csv, /coredump,data,coredump,/);
  assert.doesNotMatch(csv, /bootloader|partition_table/);
});

test('strict config rejects extra command fields and insecure third-party URLs', () => {
  const config = esp32S3Adapter.createConfig();
  assert.throws(() => parseConfig({ ...config, command: 'danger' }), /invalidConfig/);
  assert.throws(
    () =>
      parseConfig({
        ...config,
        toolchain: { ...config.toolchain, additionalUrls: ['http://example.com/index.json'] },
      }),
    /invalidConfig/,
  );
  assert.deepEqual(parseConfig(config), config);
  const colored = {
    ...config,
    partitions: config.partitions.map((partition, index) =>
      index === 0 ? { ...partition, color: '#112233' } : partition,
    ),
  };
  assert.deepEqual(parseConfig(colored), colored);
  const migrated = parseConfig({ ...config, boardId: 'generic' });
  assert.equal(migrated.boardId, 'auto');
  assert.equal(migrated.programmer?.transport, 'auto');
});

test('workspace restricts traversal, protected paths and symlink escapes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-path-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-outside-'));
  try {
    for (const relative of [
      '../escape.ino',
      'C:/escape.ino',
      '.blode/config.json',
      'file.txt:stream',
      'a/../../x.ino',
      'node_modules /escape.ts',
      'NODE_MODULES/escape.ts',
      'CON.txt',
    ])
      await assert.rejects(writeProjectFile(root, relative, 'x'));
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(safeWorkspacePath(root, 'linked/escape.ino'), /symlinkPath/);
    await writeProjectFile(root, 'include/settings.h', '#pragma once');
    assert.equal(await fs.readFile(path.join(root, 'include/settings.h'), 'utf8'), '#pragma once');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('configuration persistence round trips and refuses malformed existing config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-config-'));
  try {
    const config = esp32S3Adapter.createConfig();
    assert.deepEqual(await loadProjectConfig(root, config), config);
    config.name = 'saved';
    await persistConfig(root, config);
    assert.equal((await loadProjectConfig(root, esp32S3Adapter.createConfig())).name, 'saved');
    await fs.writeFile(path.join(root, '.blode/project.json'), '{bad');
    await assert.rejects(loadProjectConfig(root, config));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('be descriptor supplies configuration and build inputs, and saves preserve them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-be-'));
  try {
    const config = esp32S3Adapter.createConfig();
    await fs.writeFile(
      path.join(root, 'be'),
      JSON.stringify({ ...config, build: { sketch: 'main.ino', files: ['main.ino'] } }),
    );
    await fs.writeFile(path.join(root, 'main.ino'), 'void setup() {}');
    const loaded = await loadProjectDescriptor(root, esp32S3Adapter.createConfig());
    assert.equal(loaded.config.name, config.name);
    assert.deepEqual(loaded.build, { sketch: 'main.ino', files: ['main.ino'] });
    loaded.config.name = 'renamed';
    await persistConfig(root, loaded.config);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'be'), 'utf8'));
    assert.equal(saved.name, 'renamed');
    assert.equal(saved.build.sketch, 'main.ino');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('capacity parser uses compiler results and binary fallback without source-size estimates', () => {
  const defaults = {
    success: true,
    flashTotal: 3 * 1048576,
    ramTotal: 327680,
    binarySize: 512,
    artifacts: [],
  };
  const result = parseBuildOutput(
    'Sketch uses 284,632 bytes (9%) of program storage space.\nGlobal variables use 19,024 bytes (5%) of dynamic memory. Maximum is 327,680 bytes.',
    { ...defaults, ramTotal: 524288 },
  );
  assert.equal(result.flashUsed, 284632);
  assert.equal(result.ramUsed, 19024);
  assert.equal(result.ramTotal, 327680);
  assert.equal(result.flashTotal, 3 * 1048576);
  assert.equal(parseBuildOutput('', defaults).flashUsed, 512);
});

test('process cancellation stops an owned subprocess without waiting for its timeout', async () => {
  const cancellation = new AbortController();
  const pending = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    timeout: 15000,
    signal: cancellation.signal,
  });
  const timer = setTimeout(() => cancellation.abort(), 100);
  try {
    await assert.rejects(pending, /operationCancelled/);
  } finally {
    clearTimeout(timer);
  }
});

test('inventory measures binary assets and empty folders, skips caches and never follows junctions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-inventory-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-inventory-outside-'));
  try {
    await fs.mkdir(path.join(root, 'assets/empty'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets/image.bin'), Buffer.alloc(123));
    await fs.writeFile(path.join(root, 'main.cpp'), 'abc');
    await fs.writeFile(path.join(root, 'node_modules/ignored.cpp'), Buffer.alloc(999));
    await fs.writeFile(path.join(outside, 'secret.cpp'), Buffer.alloc(999));
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const editable = new Set((await readProjectFiles(root)).map((file) => file.path));
    const result = await scanProjectInventory(root, editable);
    assert.equal(result.totalBytes, 126);
    assert.equal(result.fileCount, 2);
    assert.equal(result.directoryCount, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.entries.find((entry) => entry.path === 'assets/empty')?.kind, 'directory');
    assert.equal(result.entries.find((entry) => entry.path === 'assets/image.bin')?.editable, false);
    assert.equal(result.entries.find((entry) => entry.path === 'main.cpp')?.editable, true);
    assert.equal((await scanProjectInventory(root, editable, { entries: 1, depth: 32 })).truncated, true);
    assert.equal((await scanProjectInventory(root, editable, { entries: 5000, depth: 0 })).truncated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('native watcher reports external file creation and closes cleanly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-watch-'));
  let close = () => {};
  let timer: ReturnType<typeof setTimeout>;
  try {
    const changed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Watcher missed external change')), 3000);
      close = watchWorkspace(
        root,
        () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      );
    });
    await fs.writeFile(path.join(root, 'external.cpp'), 'extern int count;');
    await changed;
  } finally {
    close();
    clearTimeout(timer!);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('successful capacities survive core restart and become stale after source or artifact edits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-build-state-'));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-build-data-'));
  let core: Awaited<ReturnType<typeof createCore>> | null = null;
  try {
    const config = stm32Adapter.createConfig();
    config.programmer!.serialNumber = '0123456789ABCDEF';
    config.programmer!.targetChipId = '0x410';
    await persistConfig(root, config);
    await fs.writeFile(path.join(root, 'firmware.bin'), Buffer.alloc(1234, 7));
    core = await createCore({ projectRoot: root, dataRoot, onEvent: () => {} });
    const built = await core.build();
    assert.equal(built.flashUsed, 1234);
    assert.equal((await core.getState()).buildStale, false);
    await core.shutdown();
    core = await createCore({ projectRoot: root, dataRoot, onEvent: () => {} });
    const restored = await core.getState();
    assert.equal(restored.lastBuild?.flashUsed, 1234);
    assert.equal(restored.lastBuild?.timestamp, built.timestamp);
    assert.equal(restored.buildStale, false);
    await fs.writeFile(path.join(root, 'extra.cpp'), 'int changed;');
    assert.equal((await core.getState()).buildStale, true);
    assert.equal((await core.getState()).lastBuild?.flashUsed, 1234);
    await fs.rm(path.join(root, 'extra.cpp'));
    await fs.writeFile(path.join(root, 'firmware.bin'), Buffer.alloc(1234, 9));
    assert.equal((await core.getState()).buildStale, true);
    const persisted = JSON.parse(await fs.readFile(path.join(root, '.blode/build-state.json'), 'utf8'));
    persisted.result.artifacts = ['../../outside.bin'];
    await fs.writeFile(path.join(root, '.blode/build-state.json'), JSON.stringify(persisted));
    assert.equal(await loadBuildState(root), null);
  } finally {
    await core?.shutdown();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
