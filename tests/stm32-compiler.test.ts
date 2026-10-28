import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Stm32Compiler, inspectStm32Elf, validateStm32Binary } from '../extensions/boards/stm32/compiler';
import { stm32Adapter } from '../extensions/boards/stm32/adapter';
import { createStm32Runtime } from '../extensions/boards/stm32/runtime';
import { safeWorkspacePath } from '../src/core/workspace';
import type { RuntimeHost } from '../extensions/runtime';
import type { BuildResult } from '../src/shared/contracts';

function executable(name: string) {
  return name + (process.platform === 'win32' ? '.exe' : '');
}
function elfFixture() {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = 1;
  bytes[5] = 1;
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(40, 18);
  bytes.writeUInt32LE(52, 28);
  bytes.writeUInt16LE(32, 42);
  bytes.writeUInt16LE(1, 44);
  bytes.writeUInt32LE(84, 32);
  bytes.writeUInt16LE(40, 46);
  bytes.writeUInt16LE(3, 48);
  bytes.writeUInt32LE(1, 52);
  bytes.writeUInt32LE(0x08000000, 60);
  bytes.writeUInt32LE(0x08000000, 64);
  bytes.writeUInt32LE(32, 68);
  bytes.writeUInt32LE(48, 72);
  for (const [index, address, size, type] of [
    [1, 0x20000000, 4, 1],
    [2, 0x20000004, 12, 8],
  ]) {
    const base = 84 + index * 40;
    bytes.writeUInt32LE(type, base + 4);
    bytes.writeUInt32LE(3, base + 8);
    bytes.writeUInt32LE(address, base + 12);
    bytes.writeUInt32LE(size, base + 20);
  }
  return bytes;
}
function binaryFixture() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0x20005000, 0);
  bytes.writeUInt32LE(0x08000009, 4);
  return bytes;
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-stm32-compiler-'));
  const project = path.join(root, 'project with spaces');
  const compilerRoot = path.join(root, 'tools', 'armclang');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(compilerRoot, 'bin'), { recursive: true });
  for (const name of ['armclang', 'armlink', 'fromelf', 'armasm'])
    await fs.writeFile(path.join(compilerRoot, 'bin', executable(name)), 'fixture');
  await fs.writeFile(path.join(project, 'src/main.c'), '#include "helper.h"\nint main(void){for(;;){} }');
  await fs.writeFile(path.join(project, 'src/helper.c'), 'int helper(void){return 1;}');
  await fs.writeFile(path.join(project, 'src/helper.h'), 'int helper(void);');
  const calls: { tool: string; args: string[] }[] = [];
  let failing = false;
  const host: RuntimeHost = {
    dataRoot: path.join(root, 'data'),
    toolchainRoot: path.join(root, 'tools'),
    signal: new AbortController().signal,
    emit() {},
    projectRoot: () => project,
    readProjectFiles: async () => [],
    resolveWorkspacePath: (relative, options) => safeWorkspacePath(project, relative, options),
    async resetDirectory(relative) {
      assert.equal(relative, '.blode/build');
      const target = await safeWorkspacePath(project, relative, { internal: true });
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target, { recursive: true });
      return target;
    },
    listPorts: async () => [],
    requirePort: async () => {
      throw Error('No hardware');
    },
    closeSerial: async () => {},
    async runCommand(command, args) {
      const tool = path.basename(command).replace(/\.exe$/i, '');
      calls.push({ tool, args });
      if (args.includes('--version')) return { code: 0, output: 'Arm Compiler for Embedded 6.22' };
      if (failing) return { code: 1, output: 'main.c:3: error: expected expression' };
      if (tool === 'armclang' || tool === 'armasm')
        await fs.writeFile(args[args.indexOf('-o') + 1], 'object');
      if (tool === 'armlink') await fs.writeFile(args[args.indexOf('-o') + 1], elfFixture());
      if (tool === 'fromelf') await fs.writeFile(args[args.indexOf('--output') + 1], binaryFixture());
      return { code: 0, output: `${tool} completed` };
    },
  };
  const config = stm32Adapter.createConfig();
  config.programmer!.serialNumber = '75010001230046504E413836';
  config.programmer!.targetChipId = '0x410';
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('blode-stm32-compiler-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    host,
    config,
    calls,
    compiler: new Stm32Compiler(host),
    fail: () => {
      failing = true;
    },
  };
}

test('STM32 C entry invokes compiler, linker and binary conversion, returning actual ELF usage', async (t) => {
  const { compiler, config, calls, project } = await fixture(t);
  const result = await compiler.build(config, { entry: 'src/main.c' });
  assert.equal(result.success, true);
  assert.equal(result.flashUsed, 32);
  assert.equal(result.ramUsed, 16 + 1024);
  assert.equal(result.ramTotal, 20480);
  assert.deepEqual(result.artifacts, ['.blode/build/firmware.bin']);
  assert.equal(
    calls.filter((call) => call.tool === 'armclang').length,
    3,
    'main, helper and target startup are compiled',
  );
  const main = calls.find((call) => call.args.includes(path.join(project, 'src/main.c')))!;
  assert.ok(main.args.includes('--target=arm-arm-none-eabi'));
  assert.ok(main.args.includes('-mcpu=cortex-m3'));
  assert.ok(calls.some((call) => call.tool === 'armlink'));
  assert.ok(calls.some((call) => call.tool === 'fromelf' && call.args.includes('--bin')));
  const startup = await fs.readFile(path.join(project, '.blode/build/startup_f1_md.c'), 'utf8');
  assert.match(startup, /__main\(\);/);
  assert.doesNotMatch(startup, /\(void\)main\(\)/);
  assert.match(startup, /0x20005000u/);
});

test('STM32 links within physical Flash and reports the soft application budget', async (t) => {
  const { compiler, config, project } = await fixture(t);
  config.flashSize = 64 * 1024;
  config.partitions[0]!.size = 4 * 1024;
  const result = await compiler.build(config, { entry: 'src/main.c' });
  assert.equal(result.flashTotal, 4 * 1024);
  assert.equal(result.flashUsed, 32);
  const scatter = await fs.readFile(path.join(project, '.blode/build/stm32_f1_md.sct'), 'utf8');
  assert.match(scatter, /LR_FLASH 0x08000000 0x10000/);
  assert.match(scatter, /ER_FLASH 0x08000000 0x10000/);

  const tiny = {
    ...config,
    partitions: [{ ...config.partitions[0]!, size: 16 }],
  };
  const warned = await compiler.build(tiny, { entry: 'src/main.c' });
  assert.equal(warned.flashTotal, 16);
  assert.match(warned.output, /WARNING: firmware exceeds the application region/);
});

test('STM32 entry directories include the whole selected tree and fingerprint headers beyond editor limits', async (t) => {
  const { compiler, project } = await fixture(t);
  const deep = ['src', ...Array.from({ length: 10 }, (_, index) => `level${index}`)].join('/');
  await fs.mkdir(path.join(project, deep), { recursive: true });
  for (let index = 0; index < 170; index++)
    await fs.writeFile(path.join(project, deep, `header${index}.h`), '#pragma once');
  await fs.mkdir(path.join(project, '.blode'), { recursive: true });
  await fs.writeFile(path.join(project, '.blode/ignored.c'), 'bad');
  const inputs = await compiler.buildInputs({ entry: '.' });
  assert.equal(inputs.length, 173);
  assert.ok(inputs.includes(`${deep}/header169.h`));
  assert.ok(!inputs.includes('.blode/ignored.c'));
  assert.deepEqual(await compiler.buildInputs({}), ['firmware.bin']);
  await assert.rejects(compiler.buildInputs({ entry: '../escape.c' }), /invalidPath/);
  await assert.rejects(compiler.buildInputs({ entry: 'src/helper.h' }), /invalidBuildEntry/);
});

test('STM32 prefers an explicitly compatible project startup/scatter pair and does not generate replacements', async (t) => {
  const { compiler, project, config, calls } = await fixture(t);
  await fs.writeFile(
    path.join(project, 'src/startup.s'),
    'AREA RESET, DATA, READONLY\nEXPORT Reset_Handler\n',
  );
  await fs.writeFile(path.join(project, 'firmware.sct'), 'LR_FLASH 0x08000000 0x10000 {}');
  await compiler.build(config, { entry: 'src' });
  assert.equal(calls.filter((call) => call.tool === 'armasm').length, 1);
  assert.ok(calls.find((call) => call.tool === 'armlink')!.args.includes(path.join(project, 'firmware.sct')));
  await assert.rejects(fs.access(path.join(project, '.blode/build/startup_f1_md.c')), { code: 'ENOENT' });
});

test('unknown STM32 chips are not guessed into the F1 startup/memory profile', async (t) => {
  const { compiler, config, calls } = await fixture(t);
  config.programmer!.targetChipId = '0x999';
  await assert.rejects(compiler.build(config, { entry: 'src/main.c' }), /stm32CompilerProfileRequired/);
  assert.equal(calls.length, 0);
});

test('scatter-file executable preprocessor commands are refused before invoking the linker', async (t) => {
  const { compiler, project, config, calls } = await fixture(t);
  await fs.writeFile(
    path.join(project, 'src/startup.s'),
    'AREA RESET, DATA, READONLY\nEXPORT Reset_Handler\n',
  );
  await fs.writeFile(path.join(project, 'firmware.sct'), '#! powershell.exe arbitrary-project-script.ps1\n');
  await assert.rejects(compiler.build(config, { entry: 'src' }), /stm32ScatterPreprocessor/);
  assert.ok(!calls.some((call) => call.tool === 'armlink'));
});

test('C++ compilation retains hosted main naming and uses the AC6 initializer runtime', async (t) => {
  const { compiler, project, config, calls } = await fixture(t);
  await fs.writeFile(
    path.join(project, 'src/main.cpp'),
    'volatile unsigned value; struct Init{Init(){value=1;}}; Init init; int main(){for(;;){}}',
  );
  await compiler.build(config, { entry: 'src/main.cpp', files: ['src/main.cpp'] });
  const cxx = calls.find((call) => call.args.includes(path.join(project, 'src/main.cpp')))!;
  assert.ok(cxx.args.includes('-std=gnu++17'));
  assert.ok(!cxx.args.includes('-ffreestanding'));
  const startup = await fs.readFile(path.join(project, '.blode/build/startup_f1_md.c'), 'utf8');
  assert.match(startup, /__main\(\);/);
  const scatter = await fs.readFile(path.join(project, '.blode/build/stm32_f1_md.sct'), 'utf8');
  assert.match(scatter, /RW_RAM 0x20000000 0x4c00/);
  assert.match(scatter, /ARM_LIB_STACK 0x20005000 EMPTY -0x400/);
});

test('compiler diagnostics stop the pipeline before linking or producing a firmware binary', async (t) => {
  const { compiler, config, calls, fail } = await fixture(t);
  fail();
  await assert.rejects(compiler.build(config, { entry: 'src/main.c' }), /expected expression/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'armclang');
});

test('compiler discovery accepts a complete absolute PATH directory and never overrides an explicit directory', async (t) => {
  const { compiler, config, host, root, calls } = await fixture(t);
  const complete = path.join(root, 'tools/armclang/bin');
  const partial = path.join(root, 'partial');
  await fs.mkdir(partial);
  await fs.writeFile(path.join(partial, executable('armclang')), 'fixture');
  host.toolchainRoot = path.join(root, 'missing-tools');
  host.env = { PATH: ['', 'relative-cwd', partial, complete].join(path.delimiter) };
  assert.equal((await compiler.status(config)).installed, true);
  assert.equal(calls[0].tool, 'armclang');
  config.toolchain.armCompilerDirectory = partial;
  assert.equal((await compiler.status(config)).installed, false);
  assert.equal(calls.length, 1, 'an explicit incomplete directory must not use PATH');
  await assert.rejects(compiler.build(config, { entry: 'src/main.c' }), /armCompilerMissing/);
});

test('native Arm startup requires armasm in the selected toolchain directory', async (t) => {
  const { compiler, project, config, root, calls } = await fixture(t);
  await fs.unlink(path.join(root, 'tools/armclang/bin', executable('armasm')));
  await fs.writeFile(
    path.join(project, 'src/startup.s'),
    'AREA RESET, DATA, READONLY\nEXPORT Reset_Handler\n',
  );
  await fs.writeFile(path.join(project, 'firmware.sct'), 'LR_FLASH 0x08000000 0x10000 {}');
  await assert.rejects(compiler.build(config, { entry: 'src/main.c' }), /armCompilerMissing/);
  assert.ok(!calls.some((call) => call.tool === 'armasm' || call.tool === 'armlink'));
});

test('ELF/binary validation rejects wrong architectures, overflow and invalid Cortex-M vectors', () => {
  assert.deepEqual(inspectStm32Elf(elfFixture(), 65536, 20480), { flashUsed: 32, ramUsed: 16 });
  const badMachine = elfFixture();
  badMachine.writeUInt16LE(62, 18);
  assert.throws(() => inspectStm32Elf(badMachine, 65536, 20480), /stm32InvalidElf/);
  const ramOverflow = elfFixture();
  ramOverflow.writeUInt32LE(0x20005000, 84 + 2 * 40 + 12);
  assert.throws(() => inspectStm32Elf(ramOverflow, 65536, 20480), /stm32RamOutOfBounds/);
  const flashOverflow = elfFixture();
  flashOverflow.writeUInt32LE(65537, 68);
  assert.throws(() => inspectStm32Elf(flashOverflow, 65536, 20480), /firmwareOutOfBounds/);
  const shiftedLoad = elfFixture();
  shiftedLoad.writeUInt32LE(0x08000800, 64);
  assert.throws(() => inspectStm32Elf(shiftedLoad, 65536, 20480), /stm32InvalidElf/);
  assert.doesNotThrow(() => validateStm32Binary(binaryFixture(), 65536, 20480));
  const vector = binaryFixture();
  vector.writeUInt32LE(0x08000008, 4);
  assert.throws(() => validateStm32Binary(vector, 65536, 20480), /stm32InvalidVector/);
});

test('source compilation keeps compiler selection after probing and flashes the built artifact', async (t) => {
  const { host, config, project } = await fixture(t);
  config.toolchain.armCompilerDirectory = path.join(path.dirname(project), 'tools/armclang');
  let flashed = '';
  const device = {
    serialNumber: config.programmer!.serialNumber,
    name: 'ST-Link',
    chipId: '0x410',
    flashSize: 65536,
  };
  const runtime = createStm32Runtime(host, {
    status: async () => ({ installed: true, version: '1.9.0' }),
    listProbes: async () => [device],
    probe: async () => ({ device, output: 'probe' }),
    install: async () => {},
    flash: async (options) => {
      flashed = options.file;
      return 'verified';
    },
  });
  const detected = await runtime.probe(config);
  assert.equal(detected.config.toolchain.armCompilerDirectory, config.toolchain.armCompilerDirectory);
  const result = await runtime.build(detected.config, { entry: 'src/main.c' });
  await runtime.flash(detected.config, result);
  assert.equal(flashed, path.join(project, '.blode/build/firmware.bin'));
  const legacy = await runtime.build(detected.config, { sketch: 'src/main.c' });
  assert.deepEqual(legacy.artifacts, ['.blode/build/firmware.bin']);
  const precompiled = { ...result, artifacts: ['firmware.bin'] } satisfies BuildResult;
  await runtime.flash(detected.config, precompiled);
  assert.equal(flashed, path.join(project, 'firmware.bin'));
});
