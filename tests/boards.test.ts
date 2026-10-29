import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getBoardAdapter, listBoards } from '../extensions/registry.js';
import { createDefaultPartitions } from '../extensions/boards/Esp32_S3_CAM/partitions.js';
import { buildFlashArgs, buildProbeArgs } from '../extensions/boards/Esp32_S3_CAM/programmer.js';
import { parseConfig } from '../src/core/config.js';

describe('board adapters', () => {
  it('returns fresh configuration, never sharing edited partition objects', () => {
    const adapter = getBoardAdapter('Esp32_S3_CAM');
    const edited = adapter.createConfig();
    edited.partitions[0]!.size = 1;
    assert.equal(adapter.createConfig().partitions[0]!.size, 0x8000);
    const definitions = listBoards();
    definitions.find((board) => board.id === 'Esp32_S3_CAM')!.flashSizes.length = 0;
    assert.ok(listBoards().find((board) => board.id === 'Esp32_S3_CAM')!.flashSizes.length > 0);
    assert.equal(getBoardAdapter('auto').createConfig().flashSize, 0);
    assert.deepEqual(getBoardAdapter('auto').createConfig().partitions, []);
  });
  for (const size of [4, 8, 16, 32])
    it(`fills a ${size} MiB image without gaps, overlap or exceeding capacity`, () => {
      const partitions = createDefaultPartitions(size * 1024 * 1024);
      for (let index = 1; index < partitions.length; index++) {
        assert.equal(partitions[index]!.offset, partitions[index - 1]!.offset + partitions[index - 1]!.size);
      }
      const last = partitions.at(-1)!;
      assert.equal(last.offset + last.size, size * 1024 * 1024);
      assert.equal(partitions.find((partition) => partition.type === 'app')!.offset % 0x10000, 0);
      assert.deepEqual(
        partitions.find((partition) => partition.id === 'coredump'),
        { id: 'coredump', name: 'coredump', type: 'data', offset: 0x310000, size: 0x10000 },
      );
      assert.equal(partitions.find((partition) => partition.id === 'filesystem')!.offset, 0x320000);
    });
  it('synchronizes FlashSize and PSRAM while keeping runtime baud out of compiler options', () => {
    const adapter = getBoardAdapter('Esp32_S3_CAM');
    const config = adapter.createConfig();
    config.flashSize = 16 * 1024 * 1024;
    config.toolchain.fqbn += ':PSRAM=opi,FlashSize=8M,CDCOnBoot=cdc,UploadSpeed=460800';
    assert.equal(adapter.getFqbn(config), 'esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,CDCOnBoot=cdc');
    config.toolchain.fqbn = 'esp32:esp32:esp32c3';
    assert.throws(() => adapter.getFqbn(config), /errors.boardFqbnMismatch/);
  });
  it('rejects unknown adapters rather than falling back to another chip', () => {
    assert.throws(() => getBoardAdapter('unregistered-chip'), /errors.unknownBoard/);
  });
  it('resolves managed Python automatically and preserves required system reservations', () => {
    const adapter = getBoardAdapter('Esp32_S3_CAM');
    assert.equal(adapter.createConfig().toolchain.python, '');
    adapter.validateConfig(adapter.createConfig());
    for (const id of ['bootloader', 'partition-table']) {
      const moved = adapter.createConfig();
      moved.partitions.find((partition) => partition.id === id)!.offset += 0x1000;
      assert.throws(() => adapter.validateConfig(moved), /errors.systemPartitionLocked/);
      const deleted = adapter.createConfig();
      deleted.partitions = deleted.partitions.filter((partition) => partition.id !== id);
      assert.throws(() => adapter.validateConfig(deleted), /errors.systemPartitionLocked/);
    }
    const extraSystem = adapter.createConfig();
    extraSystem.partitions.find((partition) => partition.id === 'nvs')!.type = 'system';
    assert.throws(() => adapter.validateConfig(extraSystem), /errors.systemPartitionLocked/);
  });
  it('rejects implicit OTA layouts until subtype and boot-selection support is implemented', () => {
    const adapter = getBoardAdapter('Esp32_S3_CAM');
    const config = adapter.createConfig();
    config.partitions.push({ id: 'ota', name: 'ota_0', type: 'app', offset: 0x400000, size: 0x100000 });
    assert.throws(() => adapter.validateConfig(config), /errors.singleAppRequired/);
  });
  it('keeps existing single-app configurations without a coredump region valid', () => {
    const adapter = getBoardAdapter('Esp32_S3_CAM');
    const config = adapter.createConfig();
    config.partitions = config.partitions.filter((partition) => partition.id !== 'coredump');
    const filesystem = config.partitions.find((partition) => partition.id === 'filesystem')!;
    filesystem.offset -= 0x10000;
    filesystem.size += 0x10000;
    assert.doesNotThrow(() => adapter.validateConfig(config));
  });
});

describe('board catalogue', () => {
  it('keeps every chip definition inside extensions/boards with its manifest', () => {
    for (const board of listBoards()) {
      const manifest = path.join(process.cwd(), 'extensions', 'boards', board.id, 'manifest.json');
      assert.ok(existsSync(manifest), `${board.id} needs extensions/boards/${board.id}/manifest.json`);
      assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).id, board.id);
    }
  });
  it('starts in automatic detection and rejects an unregistered chip', () => {
    const automatic = getBoardAdapter('auto');
    assert.equal(automatic.createConfig().boardId, 'auto');
    assert.doesNotThrow(() => parseConfig(automatic.createConfig()));
    assert.throws(
      () => parseConfig({ ...automatic.createConfig(), boardId: 'unregistered-chip' }),
      /errors.unknownBoard/,
    );
  });
  it('rebuilds the layout for the physically detected Flash capacity', () => {
    const adapter = getBoardAdapter('Esp32_S3_CAM');
    const config = adapter.createConfigForFlash!(16 * 1024 * 1024);
    assert.equal(config.flashSize, 16 * 1024 * 1024);
    assert.equal(config.partitions.at(-1)!.offset + config.partitions.at(-1)!.size, 16 * 1024 * 1024);
    assert.doesNotThrow(() => adapter.validateConfig(config));
  });
});

describe('universal ESP programmer', () => {
  it('probes by auto detection with a read-only command', () => {
    assert.deepEqual(buildProbeArgs('COM3'), [
      '-m',
      'esptool',
      '--chip',
      'auto',
      '--port',
      'COM3',
      '--baud',
      '115200',
      'flash-id',
    ]);
  });
  it('keeps paths with spaces as a single argument and orders images by address', () => {
    const args = buildFlashArgs(
      'COM3',
      460800,
      [
        { offset: 0x10000, path: 'C:\\my sketch\\app.bin', size: 100 },
        { offset: 0, path: 'boot.bin', size: 100 },
      ],
      'esp32s3',
      8 * 1024 * 1024,
    );
    assert.deepEqual(args.slice(-4), ['0x0', 'boot.bin', '0x10000', 'C:\\my sketch\\app.bin']);
    assert.ok(!args.includes('--force'));
    assert.ok(!args.includes('--erase-all'));
  });
  it('rejects overlapping erase sectors, option injection, unaligned and oversized images', () => {
    assert.throws(
      () =>
        buildFlashArgs('COM3', 115200, [
          { offset: 0, path: 'a', size: 4097 },
          { offset: 4096, path: 'b', size: 1 },
        ]),
      /errors.overlappingFirmware/,
    );
    assert.throws(() => buildProbeArgs('--port'), /errors.invalidPort/);
    assert.throws(
      () => buildFlashArgs('COM3', 115200, [{ offset: 1, path: 'a' }]),
      /errors.invalidFlashOffset/,
    );
    assert.throws(
      () => buildFlashArgs('COM3', 115200, [{ offset: 0, path: '--force' }]),
      /errors.invalidFirmwarePath/,
    );
    assert.throws(
      () =>
        buildFlashArgs(
          'COM3',
          115200,
          [{ offset: 0, path: 'a', size: 5 * 1024 * 1024 }],
          'auto',
          4 * 1024 * 1024,
        ),
      /errors.firmwareOutOfBounds/,
    );
  });
});
