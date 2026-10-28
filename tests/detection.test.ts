import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build as bundle } from 'esbuild';
import { createCore, type CoreService } from '../src/core/service';
import { SerialConnection } from '../src/core/serial';
import { Drivers } from '../src/core/drivers';
import { persistConfig, loadProjectDescriptor } from '../src/core/workspace';
import { getBoardAdapter, listBoards } from '../extensions/registry';
import { createEsp32S3Runtime } from '../extensions/boards/esp32-s3/runtime';
import { createStm32Runtime } from '../extensions/boards/stm32/runtime';
import type { DebugProbeInfo, PortInfo } from '../src/shared/contracts';

const device: DebugProbeInfo = {
  serialNumber: '75010001230046504E413836',
  name: 'ST-Link/V2',
  description: 'STM32F1xx_MD',
  chipId: '0x410',
  flashSize: 128 * 1024,
  ramSize: 20 * 1024,
};
const acpi: PortInfo = { path: 'COM1', manufacturer: 'ACPI motherboard port' };
const usb: PortInfo = { path: 'COM7', manufacturer: 'USB UART', vendorId: '10C4', productId: 'EA60' };

async function fixture(
  t: TestContext,
  options: {
    ports?: PortInfo[];
    probes?: DebugProbeInfo[];
    espOutput?: string;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-detection-test-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const ports = options.ports ?? [acpi];
  const probes = options.probes ?? [device];
  const calls = { esp: 0, stm32: 0, probeEnumeration: 0, selectedSerial: '', selectedPort: '' };
  // No native USB/COM enumeration, PnP lookup, process execution or flash occurs.
  t.mock.method(SerialConnection, 'list', async () => structuredClone(ports));
  t.mock.method(Drivers.prototype, 'statuses', async () => []);
  const automatic = getBoardAdapter('auto').createConfig();
  automatic.port = 'COM1'; // A saved monitor choice is not a detection selection.
  await persistConfig(project, automatic);
  let core: CoreService | undefined;
  t.after(async () => {
    await core?.shutdown();
    assert.ok(path.basename(root).startsWith('blode-detection-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  core = await createCore({
    projectRoot: project,
    dataRoot: path.join(root, 'data'),
    onEvent: () => {},
    createRuntimes(host) {
      const esp = createEsp32S3Runtime({
        ...host,
        async runCommand(_command, args) {
          assert.ok(args.includes('flash-id'), 'detection must not compile, install or flash');
          calls.esp++;
          calls.selectedPort = args[args.indexOf('--port') + 1];
          const output = options.espOutput ?? 'Chip type: ESP32-S3\nDetected flash size: 16MB\n';
          return { code: 0, output, stdout: output, stderr: '' };
        },
      });
      const stm32 = createStm32Runtime(host, {
        status: async () => ({ installed: true, version: '1.9.0' }),
        listProbes: async () => {
          calls.probeEnumeration++;
          return structuredClone(probes);
        },
        probe: async (serialNumber) => {
          calls.stm32++;
          calls.selectedSerial = serialNumber;
          const selected = probes.find((probe) => probe.serialNumber === serialNumber);
          assert.ok(selected, 'the core must explicitly select an enumerated probe');
          return { output: 'STM32 probe output', device: structuredClone(selected) };
        },
        flash: async () => {
          throw new Error('detection must never flash');
        },
        install: async () => {
          throw new Error('detection must never install');
        },
      });
      // Status reads are separate from detection and do not launch test tools.
      return [
        {
          ...esp,
          status: async () => ({
            arduinoCli: false,
            esp32Core: false,
            python: true,
            esptool: true,
            versions: {},
          }),
        },
        stm32,
      ];
    },
  });
  return { core, calls, project };
}

test('automatic detection selects the sole ST-Link and ignores a saved ACPI COM1 monitor port', async (t) => {
  const { core, calls, project } = await fixture(t);
  const scan = await core.scanDevices();
  assert.deepEqual(
    scan.candidates.map((candidate) => candidate.transport),
    ['stlink'],
  );
  await core.probe();
  const state = await core.getState();
  assert.equal(calls.esp, 0);
  assert.equal(calls.stm32, 1);
  assert.equal(calls.selectedSerial, device.serialNumber);
  assert.equal(state.config.boardId, 'stm32');
  assert.equal(state.config.flashSize, device.flashSize);
  assert.equal(state.config.programmer?.targetChipId, device.chipId);
  assert.equal(state.config.port, 'COM1', 'the independent monitor port can be preserved');
  const saved = await loadProjectDescriptor(project, getBoardAdapter('auto').createConfig());
  assert.equal(saved.config.boardId, 'stm32');

  // A clone may report the wrong capacity; an explicit manual size survives a new probe.
  const manual = structuredClone(state.config);
  manual.flashSize = 64 * 1024;
  manual.flashSizeOverride = true;
  manual.partitions = [{ ...manual.partitions[0]!, size: manual.flashSize }];
  await core.saveConfig(manual);
  await core.probe();
  const reprobed = await core.getState();
  assert.equal(reprobed.config.flashSize, 64 * 1024);
  assert.equal(reprobed.config.flashSizeOverride, true);
  assert.equal(reprobed.config.partitions[0]?.size, 64 * 1024);
});

test('automatic detection refuses multiple candidates before probing either platform', async (t) => {
  const { core, calls } = await fixture(t, { ports: [acpi, usb] });
  await assert.rejects(core.probe(), { message: 'error.multipleDetectionDevices' });
  assert.equal(calls.esp, 0);
  assert.equal(calls.stm32, 0);
  assert.equal((await core.getState()).config.boardId, 'auto');
});

test('automatic detection refuses zero devices instead of falling back to ACPI COM1', async (t) => {
  const { core, calls } = await fixture(t, { probes: [] });
  await assert.rejects(core.probe(), { message: 'error.noDetectionDevices' });
  assert.equal(calls.esp, 0);
  assert.equal(calls.stm32, 0);
  assert.equal((await core.getState()).config.boardId, 'auto');
});

test('an explicit USB serial selection only invokes ESP32-S3 and promotes its real flash capacity', async (t) => {
  const { core, calls } = await fixture(t, { ports: [acpi, usb] });
  await core.probe('COM7');
  const state = await core.getState();
  assert.equal(calls.esp, 1);
  assert.equal(calls.selectedPort, 'COM7');
  assert.equal(calls.stm32, 0);
  assert.equal(calls.probeEnumeration, 0);
  assert.equal(state.config.boardId, 'esp32-s3');
  assert.equal(state.config.flashSize, 16 * 1024 * 1024);
  assert.equal(state.config.port, 'COM7');
});

test('an explicitly selected USB device reporting an unsupported ESP model is rejected', async (t) => {
  const { core, calls } = await fixture(t, {
    ports: [usb],
    espOutput: 'Chip type: ESP32-C3\nDetected flash size: 4MB\n',
  });
  await assert.rejects(core.probe('COM7'), { message: 'error.boardNotDetected' });
  assert.equal(calls.esp, 1);
  assert.equal(calls.stm32, 0);
  assert.equal((await core.getState()).config.boardId, 'auto');
});

test('the board catalogue contains automatic detection and exactly the two supported platforms', () => {
  assert.deepEqual(
    listBoards()
      .map((board) => board.id)
      .sort(),
    ['auto', 'esp32-s3', 'stm32'],
  );
  assert.throws(() => getBoardAdapter('generic'), /unknownBoard/);
});

for (const [platformId, transport] of [
  ['esp32-s3', 'serial'],
  ['stm32', 'stlink'],
] as const) {
  test(`${platformId} runtime bundles after copying only its platform folder to an isolated directory`, async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-platform-copy-'));
    const copied = path.join(root, platformId);
    try {
      await fs.cp(path.resolve('extensions/boards', platformId), copied, { recursive: true });
      const manifest = JSON.parse(await fs.readFile(path.join(copied, 'manifest.json'), 'utf8'));
      assert.equal(manifest.runtime, 'runtime.ts');
      assert.equal(manifest.runtimeApiVersion, 1);
      assert.equal(manifest.transport, transport);
      const builtin = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
      const result = await bundle({
        entryPoints: [path.join(copied, manifest.runtime)],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        write: false,
        metafile: true,
        logLevel: 'silent',
        plugins: [
          {
            name: 'isolated-platform-dependencies',
            setup(build) {
              build.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === 'entry-point') return undefined;
                if (builtin.has(args.path.replace(/^node:/, ''))) return { path: args.path, external: true };
                if (!args.path.startsWith('.'))
                  return { errors: [{ text: `Unexpected package dependency: ${args.path}` }] };
                const target = path.resolve(args.resolveDir, args.path);
                const relative = path.relative(copied, target);
                if (relative.startsWith('..') || path.isAbsolute(relative))
                  return { errors: [{ text: `Platform dependency escapes its folder: ${args.path}` }] };
                return undefined;
              });
            },
          },
        ],
      });
      assert.equal(result.warnings.length, 0);
      assert.ok(result.outputFiles[0].contents.length > 0);
      for (const input of Object.keys(result.metafile.inputs)) {
        const file = path.resolve(input);
        const relative = path.relative(copied, file);
        assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
        // Type-only imports must also respect the stable SDK boundary.
        const source = await fs.readFile(file, 'utf8');
        const imports = [...source.matchAll(/\b(?:from|import|require)\s*(?:\(\s*)?['"]([^'"]+)['"]/g)];
        assert.ok(
          imports.every((match) => !/src[\\/]core/.test(match[1])),
          `${relative} imports the core`,
        );
      }
      assert.ok(result.metafile.outputs);
      for (const output of Object.values(result.metafile.outputs))
        assert.ok(
          output.imports.every((item) => item.external && builtin.has(item.path.replace(/^node:/, ''))),
        );
    } finally {
      assert.ok(path.basename(root).startsWith('blode-platform-copy-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
