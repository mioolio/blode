import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { packageRuntime } from '../scripts/package-runtime';
import { RuntimePlugins } from '../src/core/runtime-plugins';
import { safeWorkspacePath } from '../src/core/workspace';
import type { RuntimeHost, PlatformRuntime } from '../extensions/runtime';

const executable = (name: string) => name + (process.platform === 'win32' ? '.exe' : '');
const serial = '0123456789ABCDEF';

function armElf() {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0x464c457f);
  bytes[4] = 1;
  bytes[5] = 1;
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(40, 18);
  bytes.writeUInt32LE(52, 28);
  bytes.writeUInt16LE(32, 42);
  bytes.writeUInt16LE(1, 44);
  bytes.writeUInt32LE(84, 32);
  bytes.writeUInt16LE(40, 46);
  bytes.writeUInt16LE(1, 48);
  bytes.writeUInt32LE(1, 52);
  bytes.writeUInt32LE(0x08000000, 60);
  bytes.writeUInt32LE(0x08000000, 64);
  bytes.writeUInt32LE(32, 68);
  bytes.writeUInt32LE(32, 72);
  return bytes;
}

async function fixture(t: TestContext, sourceId: 'STM32F103C8T6' | 'Esp32_S3_CAM') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-standard-package-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-standard-package-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  // Type-only SDK imports are erased. Actual code and all data come from this copy.
  await fs.cp(path.resolve('extensions/boards', sourceId), source, { recursive: true });
  const id = 'Standard_' + randomUUID().replaceAll('-', '');
  const output = path.join(root, 'modules');
  const packaged = await packageRuntime({ source, output, id });
  await fs.rename(source, path.join(root, 'source-moved-away'));
  assert.equal(await fs.stat(source).catch(() => null), null);
  assert.equal(packaged.manifest.compiler.mode, 'runtime');
  const manager = new RuntimePlugins({ roots: [output], dataRoot: path.join(root, 'data') });
  t.after(() => manager.close());
  const discovered = await manager.discover();
  assert.deepEqual(discovered.errors, []);
  assert.equal(discovered.plugins.length, 1);
  assert.equal(discovered.plugins[0].manifest.id, id);
  // The package's catalogs remain inspectable before any executable code is trusted.
  for (const standard of ['c99', 'c11', 'c17', 'c23'] as const) {
    const languages = await manager.languages(id, standard);
    assert.equal(languages?.moduleId, id);
    assert.deepEqual(languages?.diagnostics, []);
    assert.ok(languages!.entries[0].contributions.some((entry) => entry.symbols?.length));
  }
  assert.equal(discovered.plugins[0].trust, 'required');
  await manager.trust({
    id,
    fingerprint: discovered.plugins[0].fingerprint,
    confirm: true,
    permanent: false,
  });
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src/main.c'), 'int main(void) { for (;;) {} }');
  await fs.writeFile(path.join(project, 'main.ino'), 'void setup() {}\nvoid loop() {}');
  const tools = path.join(root, 'selected-tools');
  await fs.mkdir(tools);
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-g++', 'arm-none-eabi-objcopy', 'arduino-cli'])
    await fs.writeFile(path.join(tools, executable(name)), 'test executable placeholder');
  const commands: { tool: string; command: string; args: string[] }[] = [];
  const host: RuntimeHost = {
    dataRoot: path.join(root, 'data'),
    toolchainRoot: path.join(root, 'managed-tools'),
    signal: new AbortController().signal,
    env: { PATH: '', Path: '' },
    emit() {},
    projectRoot: () => project,
    readProjectFiles: async () => [
      { path: 'main.ino', content: 'void setup() {}\nvoid loop() {}', language: 'cpp' },
    ],
    resolveWorkspacePath: (relative, options) => safeWorkspacePath(project, relative, options),
    resetDirectory: async (relative) => {
      const target = await safeWorkspacePath(project, relative, { internal: true });
      await fs.mkdir(target, { recursive: true });
      return target;
    },
    listPorts: async () => [{ path: 'MOCK_SERIAL', vendorId: '303a', productId: '1001' }],
    requirePort: async (requested) => {
      assert.equal(requested, 'MOCK_SERIAL');
      return 'MOCK_SERIAL';
    },
    closeSerial: async () => {},
    fetcher: async () => {
      throw Error('Tests must never download tools');
    },
    async runCommand(command, args) {
      const tool = path.basename(command).replace(/\.exe$/i, '');
      commands.push({ tool, command, args });
      if (tool.startsWith('st-'))
        return {
          code: 0,
          output: args.includes('--version')
            ? 'v1.9.0'
            : `serial: ${serial}\nflash: 65536\nsram: 20480\nchipid: 0x410\ndev-type: STM32F1xx_MD\n`,
        };
      if (args.includes('core') && args.includes('list'))
        return { code: 0, output: JSON.stringify([{ id: 'esp32:esp32', installed_version: '3.3.0' }]) };
      if (args.includes('flash_id') || args.includes('flash-id'))
        return { code: 0, output: 'Chip is ESP32-S3\nDetected flash size: 16MB' };
      if (args.includes('--version') || args.includes('version'))
        return { code: 0, output: tool.startsWith('arm-none') ? 'arm-none-eabi-gcc (GNU) 15.2.1' : '1.9.0' };
      if (tool === 'arm-none-eabi-gcc' || tool === 'arm-none-eabi-g++')
        await fs.writeFile(args[args.indexOf('-o') + 1], args.includes('-c') ? 'object' : armElf());
      if (tool === 'arm-none-eabi-objcopy') {
        const bytes = Buffer.alloc(32);
        bytes.writeUInt32LE(0x20005000);
        bytes.writeUInt32LE(0x08000009, 4);
        await fs.writeFile(args.at(-1)!, bytes);
      }
      if (tool === 'arduino-cli' && args.includes('compile')) {
        const directory = args[args.indexOf('--build-path') + 1];
        for (const name of ['project.ino.bin', 'project.ino.bootloader.bin', 'project.ino.partitions.bin'])
          await fs.writeFile(path.join(directory, name), Buffer.alloc(32));
      }
      return { code: 0, output: 'mock compiler completed' };
    },
  };
  const unavailableBase = {
    id: sourceId,
    build: async () => {
      throw Error('Host builtin compiler must not be used');
    },
  } as unknown as PlatformRuntime;
  const [runtime] = manager.attach(host, [unavailableBase]);
  return {
    root,
    packaged,
    manager,
    id,
    project,
    tools,
    commands,
    runtime,
    config: structuredClone(packaged.manifest.defaultConfig),
  };
}

test('real STM32 module survives relocation with language resources, protocol and generated startup templates', async (t) => {
  const f = await fixture(t, 'STM32F103C8T6');
  f.config.toolchain.armCompilerDirectory = f.tools;
  assert.equal((await f.runtime.status(f.config, true)).gnuArm, true);
  const candidates = await f.runtime.discover(f.config);
  assert.equal(candidates[0].platformId, f.id);
  assert.equal(candidates[0].serialNumber, serial);
  const probe = await f.runtime.probe(f.config, candidates[0]);
  assert.equal(probe.config.boardId, f.id);
  assert.equal(probe.config.programmer?.targetChipId, '0x410');
  const inputs = {
    entry: 'src/main.c',
    cStandard: 'c99' as const,
    settings: {
      platforms: {
        STM32F103C8T6: { common: { family: 'arduino' as const } },
        [f.id]: { common: { family: 'gnu-arm' as const, directory: f.tools } },
      },
    },
  };
  assert.ok((await f.runtime.buildInputs!(f.config, inputs)).includes('src/main.c'));
  const result = await f.runtime.build(f.config, inputs);
  assert.equal(result.success, true);
  assert.match(
    await fs.readFile(path.join(f.project, '.blode/build/startup_f1_md.c'), 'utf8'),
    /Reset_Handler/,
  );
  assert.match(await fs.readFile(path.join(f.project, '.blode/build/stm32_f1_md.ld'), 'utf8'), /MEMORY/);
  const compile = f.commands.find((item) => item.args.includes('-c'))!;
  assert.equal(path.dirname(compile.command), f.tools);
  assert.ok(compile.args.includes('-std=gnu99'));
});

test('real ESP32 module survives relocation and uses the renamed platform compiler selection', async (t) => {
  const f = await fixture(t, 'Esp32_S3_CAM');
  const status = await f.runtime.status(f.config, true);
  assert.equal(status.arduinoCli, true);
  assert.equal(status.esp32Core, true);
  const candidates = await f.runtime.discover(f.config);
  assert.equal(candidates[0].platformId, f.id);
  const probe = await f.runtime.probe(f.config, candidates[0]);
  assert.equal(probe.config.boardId, f.id);
  assert.equal(probe.config.port, 'MOCK_SERIAL');
  const result = await f.runtime.build(f.config, {
    entry: 'main.ino',
    settings: {
      platforms: {
        Esp32_S3_CAM: { common: { family: 'gnu-arm' } },
        [f.id]: { common: { family: 'arduino', directory: f.tools } },
      },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.artifacts.length, 3);
  const compile = f.commands.find((item) => item.args.includes('compile'))!;
  assert.equal(path.dirname(compile.command), f.tools);
  assert.match(
    await fs.readFile(path.join(f.project, '.blode/staging/project/partitions.csv'), 'utf8'),
    /app/,
  );
});
