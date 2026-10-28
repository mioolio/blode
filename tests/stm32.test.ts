import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  buildStlinkFlashArgs,
  buildStlinkProbeArgs,
  parseStlinkProbes,
  STM32_FLASH_BASE,
} from '../extensions/boards/stm32/protocol';
import { stm32Adapter } from '../extensions/boards/stm32/adapter';
import { StlinkProgrammer, STLINK_WINDOWS_RELEASE } from '../extensions/boards/stm32/programmer';
import { runCommand } from '../src/core/process';

const serialA = '0672FF485650755087074224';
const serialB = '0672FF485650755087074225';
const probeBlock = (serial = serialA, flash = 65536, chip = '0x410', description = 'STM32F1xx_MD') =>
  [
    '  version:    V2J46S7',
    `  serial:     ${serial}`,
    `  flash:      ${flash} (pagesize: 1024)`,
    '  sram:       20480',
    `  chipid:     ${chip}`,
    ...(description ? [`  dev-type:   ${description}`] : []),
    '  voltage:    3260 mV',
  ].join('\n');
const twoProbes = `Found 2 stlink programmers\n1.\n${probeBlock()}\n2.\n${probeBlock(serialB, 131072)}\n`;

test('st-info parser preserves every attached probe, byte capacities and unknown targets', () => {
  const devices = parseStlinkProbes(twoProbes.replaceAll('\n', '\r\n'));
  assert.equal(devices.length, 2);
  assert.deepEqual(
    devices.map((device) => device.serialNumber),
    [serialA, serialB],
  );
  assert.equal(devices[0].flashSize, 65536);
  assert.equal(devices[1].flashSize, 131072);
  assert.equal(devices[0].ramSize, 20480);
  assert.equal(devices[0].chipId, '0x410');
  assert.equal(devices[0].description, 'STM32F1xx_MD');
  assert.deepEqual(parseStlinkProbes('Found 0 stlink programmers\n'), []);
  const [unknown] = parseStlinkProbes(probeBlock(serialA, 0, '0x000', ''));
  assert.equal(unknown.serialNumber, serialA);
  assert.equal(unknown.flashSize, undefined);
  assert.equal(unknown.chipId, undefined);
  assert.throws(() => parseStlinkProbes(`${probeBlock()}\n${probeBlock()}`), /invalidProbeSerial/);
});

test('STM32 probe is hot-plug/read-only and flash arguments select an explicit serial', () => {
  assert.deepEqual(buildStlinkProbeArgs(1800), ['--hot-plug', '--probe', '--freq=1800']);
  const options = {
    serialNumber: serialB,
    frequencyKhz: 1000,
    file: 'C:\\my firmware\\firmware.bin',
    address: STM32_FLASH_BASE,
    size: 28,
    flashSize: 65536,
  };
  const args = buildStlinkFlashArgs(options);
  assert.deepEqual(args, [
    '--serial',
    serialB,
    '--freq',
    '1000',
    '--hot-plug',
    '--format',
    'binary',
    'write',
    options.file,
    '0x8000000',
  ]);
  for (const forbidden of [
    '--mass-erase',
    '--erase-all',
    '--reset',
    '--connect-under-reset',
    '--flash',
    '--area',
  ])
    assert.ok(!args.includes(forbidden));
  for (const serialNumber of ['', '--erase', `${serialA}\n--reset`, 'not a serial'])
    assert.throws(() => buildStlinkFlashArgs({ ...options, serialNumber }), /invalidProbeSerial/);
  for (const frequencyKhz of [0, 4, -1, 1.2, NaN, 4001])
    assert.throws(() => buildStlinkProbeArgs(frequencyKhz), /invalidSwdFrequency/);
  assert.throws(() => buildStlinkFlashArgs({ ...options, file: '--mass-erase' }), /invalidFirmwarePath/);
  assert.throws(() => buildStlinkFlashArgs({ ...options, file: 'a\0b' }), /invalidFirmwarePath/);
});

test('STM32 flash addresses stay inside physical flash, including final-word padding', () => {
  const options = {
    serialNumber: serialA,
    frequencyKhz: 1800,
    file: 'firmware.bin',
    address: STM32_FLASH_BASE,
    size: 4,
    flashSize: 65536,
  };
  assert.doesNotThrow(() => buildStlinkFlashArgs({ ...options, address: STM32_FLASH_BASE + 65532, size: 3 }));
  for (const address of [0, 0x1fff0000, STM32_FLASH_BASE - 4, STM32_FLASH_BASE + 1])
    assert.throws(
      () => buildStlinkFlashArgs({ ...options, address }),
      /invalidFlashOffset|firmwareOutOfBounds/,
    );
  assert.throws(
    () => buildStlinkFlashArgs({ ...options, address: STM32_FLASH_BASE + 65532, size: 5 }),
    /firmwareOutOfBounds/,
  );
  assert.throws(() => buildStlinkFlashArgs({ ...options, size: 0 }), /invalidFirmwareSize/);
  for (const flashSize of [0, 65535, 16 * 1024 * 1024, NaN])
    assert.throws(() => buildStlinkFlashArgs({ ...options, flashSize }), /unsupportedFlashSize/);
});

test('generic STM32 adapter uses a relative firmware partition and supports source compilation', () => {
  const config = stm32Adapter.createConfig();
  assert.equal(config.boardId, 'stm32');
  assert.equal(config.flashSize, 65536);
  assert.equal(config.programmer?.transport, 'stlink');
  assert.deepEqual(config.partitions, [
    { id: 'firmware', name: 'firmware', type: 'app', offset: 0, size: 65536 },
  ]);
  assert.ok(stm32Adapter.definition.capabilities.includes('compile'));
  assert.ok(!stm32Adapter.definition.capabilities.includes('partitions'));
  config.partitions[0].size = 4;
  assert.equal(stm32Adapter.createConfig().partitions[0].size, 65536);
  for (const capacity of [32768, 196608, 8 * 1024 * 1024]) {
    const detected = stm32Adapter.createConfigForFlash!(capacity);
    assert.equal(detected.partitions[0].size, capacity);
    assert.doesNotThrow(() => stm32Adapter.validateConfig(detected));
  }
  assert.throws(() => stm32Adapter.createConfigForFlash!(65535), /unsupportedFlashSize/);
  const allocated = stm32Adapter.createConfig();
  allocated.partitions[0].size = 32 * 1024;
  assert.doesNotThrow(() => stm32Adapter.validateConfig(allocated));
  const overAllocated = stm32Adapter.createConfig();
  overAllocated.partitions[0].size = overAllocated.flashSize + 4;
  assert.throws(() => stm32Adapter.validateConfig(overAllocated), /invalidPartition/);
  const shifted = stm32Adapter.createConfig();
  shifted.partitions[0].offset = 4;
  shifted.partitions[0].size -= 4;
  assert.throws(() => stm32Adapter.validateConfig(shifted), /invalidPartition/);
  const neighbouringData = stm32Adapter.createConfig();
  neighbouringData.partitions[0].size -= 1024;
  neighbouringData.partitions.push({
    id: 'data',
    name: 'data',
    type: 'data',
    offset: 64512,
    size: 1024,
    color: '#5AA9E6',
  });
  assert.doesNotThrow(() => stm32Adapter.validateConfig(neighbouringData));
  const overlapping = stm32Adapter.createConfig();
  overlapping.partitions[0].size -= 1024;
  overlapping.partitions.push({ id: 'data', name: 'data', type: 'data', offset: 63488, size: 2048 });
  assert.throws(() => stm32Adapter.validateConfig(overlapping), /invalidPartition/);
});

test('process results preserve stdout for parsing when stderr interrupts a structured output line', async () => {
  const result = await runCommand(process.execPath, [
    '-e',
    'process.stdout.write("  serial: 0672FF485650755087074224\\n  dev-type: "); setTimeout(() => process.stderr.write("DEBUG diagnostic\\n"), 25); setTimeout(() => process.stdout.write("STM32F1xx_MD\\n  flash: 65536 (pagesize: 1024)\\n  chipid: 0x410\\n"), 75);',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, 'DEBUG diagnostic\n');
  assert.equal(parseStlinkProbes(result.stdout!)[0].description, 'STM32F1xx_MD');
  const programmer = new StlinkProgrammer({ root: 'unused-stlink-test-root', runner: async () => result });
  assert.equal((await programmer.probe(serialA, 1800)).device.description, 'STM32F1xx_MD');
});

test('backend lists multiple probes and refuses absent/unknown targets instead of selecting the first', async () => {
  const calls: { command: string; args: string[] }[] = [];
  const runner: typeof runCommand = async (command, args) => {
    calls.push({ command, args });
    return { code: 0, output: twoProbes };
  };
  const programmer = new StlinkProgrammer({ root: 'unused-stlink-test-root', runner });
  assert.equal((await programmer.listProbes()).length, 2);
  assert.equal((await programmer.probe(serialB, 1800)).device.flashSize, 131072);
  await assert.rejects(programmer.probe('AAAAAAAAAAAAAAAAAAAAAAAA', 1800), /stlinkProbeNotFound/);
  const unknown = new StlinkProgrammer({
    root: 'unused-stlink-test-root',
    runner: async () => ({ code: 0, output: probeBlock(serialA, 0, '0x000', '') }),
  });
  assert.equal((await unknown.listProbes()).length, 1);
  await assert.rejects(unknown.probe(serialA, 1800), /stlinkTargetUnknown/);
  assert.ok(calls.every((call) => call.args.includes('--hot-plug') && !call.args.includes('--reset')));
});

test('flash rechecks the selected target and capacity, and propagates verification failures', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-stm32-flash-'));
  const file = path.join(root, 'firmware with spaces.bin');
  const calls: { command: string; args: string[] }[] = [];
  let failedVerification = false;
  const runner: typeof runCommand = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('--probe')) return { code: 0, output: twoProbes };
    return failedVerification
      ? { code: 1, output: 'Verification of flash failed at offset: 0' }
      : { code: 0, output: 'Flash written and verified!' };
  };
  try {
    await fs.writeFile(file, Buffer.alloc(32));
    const programmer = new StlinkProgrammer({ root, runner });
    const options = {
      serialNumber: serialB,
      frequencyKhz: 1800,
      file,
      address: STM32_FLASH_BASE,
      flashSize: 131072,
    };
    await assert.rejects(programmer.flash({ ...options, flashSize: 65536 }), /stlinkCapacityMismatch/);
    assert.equal(calls.length, 1);
    assert.match(
      await programmer.flash({ ...options, serialNumber: serialB.toLowerCase() }),
      /written and verified/,
    );
    const writing = calls.at(-1)!;
    assert.equal(writing.args[writing.args.indexOf('--serial') + 1], serialB);
    assert.ok(writing.args.includes(file));
    failedVerification = true;
    await assert.rejects(programmer.flash(options), /Verification of flash failed/);
    const before = calls.length;
    await assert.rejects(programmer.flash({ ...options, address: 0 }), /invalidFlashOffset/);
    assert.equal(calls.length, before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function releaseFetcher(
  bytes: Buffer,
  digest = createHash('sha256').update(bytes).digest('hex'),
  overrides: Record<string, unknown> = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = input.toString();
    if (url === STLINK_WINDOWS_RELEASE.metadataUrl)
      return new Response(
        JSON.stringify({
          tag_name: 'v1.9.0',
          draft: false,
          prerelease: false,
          assets: [
            {
              name: STLINK_WINDOWS_RELEASE.asset,
              browser_download_url: STLINK_WINDOWS_RELEASE.downloadUrl,
              digest: `sha256:${digest}`,
              size: bytes.length,
              ...overrides,
            },
          ],
        }),
      );
    assert.equal(url, STLINK_WINDOWS_RELEASE.downloadUrl);
    return new Response(Uint8Array.from(bytes));
  }) as typeof fetch;
}

test(
  'managed stlink rejects missing/wrong digests and oversized archives before extraction',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' },
  async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-stm32-checksum-'));
    let calls = 0;
    const runner: typeof runCommand = async () => {
      calls++;
      return { code: 0, output: '' };
    };
    try {
      const bytes = Buffer.from('archive fixture');
      for (const fetcher of [
        releaseFetcher(bytes, '0'.repeat(64)),
        releaseFetcher(bytes, undefined, { digest: null }),
      ]) {
        const programmer = new StlinkProgrammer({ root, runner, fetcher });
        await assert.rejects(programmer.install(), /stlinkChecksum/);
      }
      const oversized = new StlinkProgrammer({
        root,
        runner,
        fetcher: releaseFetcher(bytes, undefined, { size: 50_000_001 }),
      });
      await assert.rejects(oversized.install(), /stlinkArchiveSize/);
      assert.equal(calls, 0);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'managed stlink installation preserves chip definitions and records the verified official asset',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' },
  async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-stm32-install-'));
    const bytes = Buffer.from('verified archive fixture');
    const calls: string[][] = [];
    const runner: typeof runCommand = async (command, args) => {
      calls.push(args);
      if (command === 'tar' && args[0] === '-tf')
        return {
          code: 0,
          output: 'stlink/bin/st-info.exe\nstlink/bin/st-flash.exe\nstlink/share/stlink/chips/F1.chip\n',
        };
      if (command === 'tar' && args[0] === '-xf') {
        const destination = path.join(args[args.indexOf('-C') + 1], 'stlink');
        await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
        await fs.mkdir(path.join(destination, 'share/stlink/chips'), { recursive: true });
        for (const name of ['st-info.exe', 'st-flash.exe', 'libstlink.dll'])
          await fs.writeFile(path.join(destination, 'bin', name), 'runtime fixture');
        await fs.writeFile(path.join(destination, 'share/stlink/chips/F1.chip'), 'chip fixture');
      }
      return { code: 0, output: args.includes('--version') ? 'v1.9.0\n' : '' };
    };
    try {
      const programmer = new StlinkProgrammer({ root, runner, fetcher: releaseFetcher(bytes) });
      await programmer.install();
      assert.equal(await fs.readFile(path.join(root, 'share/stlink/chips/F1.chip'), 'utf8'), 'chip fixture');
      assert.equal(await fs.readFile(path.join(root, 'bin/libstlink.dll'), 'utf8'), 'runtime fixture');
      const lock = JSON.parse(await fs.readFile(path.join(root, 'stlink.lock.json'), 'utf8'));
      assert.equal(lock.version, 'v1.9.0');
      assert.equal(lock.asset, STLINK_WINDOWS_RELEASE.asset);
      assert.equal(lock.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith('.install-')));
      assert.equal(calls.filter((args) => args.includes('--version')).length, 2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'managed stlink refuses archive traversal and does not execute an unverified extracted tool',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' },
  async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-stm32-traversal-'));
    const calls: string[][] = [];
    const runner: typeof runCommand = async (_command, args) => {
      calls.push(args);
      return { code: 0, output: '../escape.exe\n' };
    };
    try {
      const programmer = new StlinkProgrammer({
        root,
        runner,
        fetcher: releaseFetcher(Buffer.from('archive')),
      });
      await assert.rejects(programmer.install(), /stlinkExtract/);
      assert.equal(calls.length, 1);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
