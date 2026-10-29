import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCore } from '../src/core/service';
import { createStm32Runtime } from '../extensions/boards/STM32F103C8T6/runtime';
import { getBoardAdapter } from '../extensions/registry';
import { persistConfig } from '../src/core/workspace';
import type { DebugProbeInfo } from '../src/shared/contracts';

test('ST-Link discovery, STM32 promotion and validated binary flashing work without a COM port', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-stm32-core-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const serialNumber = '0123456789ABCDEF01234567';
  let device: DebugProbeInfo = {
    serialNumber,
    name: 'ST-Link/V2',
    chipId: '0x0410',
    description: 'STM32F1xx',
    flashSize: 64 * 1024,
    ramSize: 20 * 1024,
  };
  const flashes: { serialNumber: string; file: string; address: number; flashSize: number }[] = [];
  let queries = 0;
  const hardware = {
    status: async () => ({ installed: true, version: 'v1.9.0' }),
    listProbes: async () => {
      queries++;
      return [structuredClone(device)];
    },
    probe: async (selected: string) => {
      queries++;
      assert.equal(selected, device.serialNumber);
      return { output: `chipid: ${device.chipId}`, device: structuredClone(device) };
    },
    flash: async (options: (typeof flashes)[number]) => {
      flashes.push(options);
      return 'verified';
    },
    install: async () => {},
  };
  const config = getBoardAdapter('auto').createConfig();
  config.port = '';
  config.programmer = { transport: 'stlink', serialNumber, frequencyKhz: 1800 };
  await persistConfig(project, config);
  const core = await createCore({
    projectRoot: project,
    dataRoot: path.join(root, 'data'),
    onEvent: () => {},
    createRuntimes: (host) => [createStm32Runtime(host, hardware)],
  });
  try {
    const initial = await core.getState();
    assert.equal(initial.config.port, '');
    assert.equal(initial.toolchain.stlink, true);
    assert.equal(queries, 0, 'state refresh must not connect to or reset a hardware target');
    assert.deepEqual(await core.listDebugProbes(), [device]);
    await core.probe();
    const identified = await core.getState();
    assert.equal(identified.config.boardId, 'STM32F103C8T6');
    assert.equal(identified.config.flashSize, device.flashSize);
    assert.equal(identified.config.programmer?.targetChipId, device.chipId);
    assert.equal(identified.config.port, '');
    assert.equal(identified.debugProbes[0].serialNumber, serialNumber);
    await fs.writeFile(path.join(project, 'firmware.bin'), Buffer.alloc(256, 0x7f));
    const binary = await core.build();
    assert.equal(binary.success, true);
    assert.equal(binary.flashUsed, 256);
    assert.deepEqual(binary.artifacts, ['firmware.bin']);
    await core.flash();
    assert.equal(flashes.length, 1);
    assert.equal(flashes[0].serialNumber, serialNumber);
    assert.equal(flashes[0].address, 0x08000000);
    assert.equal(flashes[0].flashSize, 64 * 1024);
    assert.equal(flashes[0].file, path.join(project, 'firmware.bin'));
    const runtimeChanged = (await core.getState()).config;
    runtimeChanged.programmer!.frequencyKhz = 950;
    await core.saveConfig(runtimeChanged);
    assert.equal(
      (await core.getState()).buildStale,
      false,
      'be runtime options must not invalidate a validated binary',
    );
    device = { ...device, chipId: '0x0411' };
    await assert.rejects(core.flash(), /error.chipMismatch/);
    assert.equal(flashes.length, 1, 'a replaced target must be rejected before programming');
    device = { ...device, chipId: '0x0410', flashSize: 32 * 1024 };
    await assert.rejects(core.flash(), /stlinkCapacityMismatch/);
    assert.equal(flashes.length, 1);
    await fs.writeFile(path.join(project, 'firmware.bin'), Buffer.alloc(256, 0x55));
    await assert.rejects(core.flash(), /error.buildRequired/);
    assert.equal(flashes.length, 1, 'changed firmware must be revalidated before programming');

    // A user may cap a clone part below its (wrong) reported capacity.
    device = { ...device, chipId: '0x0410', flashSize: 64 * 1024 };
    const manual = structuredClone((await core.getState()).config);
    manual.flashSize = 32 * 1024;
    manual.flashSizeOverride = true;
    manual.partitions = [{ ...manual.partitions[0]!, size: manual.flashSize }];
    await core.saveConfig(manual);
    await core.build();
    await core.flash();
    assert.equal(flashes.length, 2);
    assert.equal(flashes[1]?.flashSize, 32 * 1024);
  } finally {
    await core.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('STM32 probing requires an explicit probe while offline validation only requires firmware', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-stm32-selection-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  await persistConfig(project, config);
  let connected = false;
  const core = await createCore({
    projectRoot: project,
    dataRoot: path.join(root, 'data'),
    onEvent: () => {},
    createRuntimes: (host) => [
      createStm32Runtime(host, {
        status: async () => ({ installed: true, version: 'v1.9.0' }),
        listProbes: async () => [],
        probe: async () => {
          connected = true;
          throw new Error('must not connect');
        },
        flash: async () => {
          throw new Error('must not flash');
        },
        install: async () => {},
      }),
    ],
  });
  try {
    await assert.rejects(core.probe(), /selectDebugProbe/);
    await assert.rejects(core.build(), /noFirmware/);
    assert.equal(connected, false);
  } finally {
    await core.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
