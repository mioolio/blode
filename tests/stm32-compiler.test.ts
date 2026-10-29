import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  Stm32Compiler,
  inspectStm32Elf,
  validateStm32Binary,
} from '../extensions/boards/STM32F103C8T6/compiler';
import { createF1GnuLinkerScript, createF1GnuStartup } from '../extensions/boards/STM32F103C8T6/templates';
import { GNU_WINDOWS_RELEASE, GnuArmToolchain } from '../extensions/boards/STM32F103C8T6/gnu';
import { stm32Adapter } from '../extensions/boards/STM32F103C8T6/adapter';
import { createStm32Runtime } from '../extensions/boards/STM32F103C8T6/runtime';
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
  const calls: { tool: string; args: string[]; command: string }[] = [];
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
      calls.push({ tool, args, command });
      if (args.includes('--version'))
        return {
          code: 0,
          output:
            tool === 'arm-none-eabi-gcc'
              ? 'arm-none-eabi-gcc (GNU) 15.2.1'
              : 'Arm Compiler for Embedded 6.22',
        };
      if (failing) return { code: 1, output: 'main.c:3: error: expected expression' };
      if (tool === 'armclang' || tool === 'armasm')
        await fs.writeFile(args[args.indexOf('-o') + 1], 'object');
      if (tool === 'arm-none-eabi-gcc' || tool === 'arm-none-eabi-g++') {
        const output = args.indexOf('-o');
        if (output >= 0) await fs.writeFile(args[output + 1], args.includes('-c') ? 'object' : elfFixture());
      }
      if (tool === 'arm-none-eabi-objcopy') await fs.writeFile(args.at(-1)!, binaryFixture());
      if (tool === 'armlink') await fs.writeFile(args[args.indexOf('-o') + 1], elfFixture());
      if (tool === 'fromelf') await fs.writeFile(args[args.indexOf('--output') + 1], binaryFixture());
      return { code: 0, output: `${tool} completed` };
    },
  };
  const config = stm32Adapter.createConfig();
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
  const result = await compiler.build(config, { entry: 'src/main.c', cStandard: 'c99' });
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
  assert.ok(main.args.includes('-std=gnu99'));
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

test('the named F103C8 profile accepts C8/C8T6 Keil targets and does not relabel other F103 parts', async (t) => {
  const { compiler, config, project, host, calls } = await fixture(t);
  const runtime = createStm32Runtime(host);
  const descriptor = (device: string) =>
    `<Project><Targets><Target><TargetName>Main</TargetName><Device>${device}</Device><Groups><Group><Files><File><FilePath>src/main.c</FilePath></File></Files></Group></Groups></Target></Targets></Project>`;
  for (const device of ['STM32F103C8', 'STM32F103C8T6']) {
    await fs.writeFile(path.join(project, 'Project.uvprojx'), descriptor(device));
    assert.equal(await compiler.projectDevice({ entry: 'src/main.c' }), device);
    const selected = await runtime.projectConfig!(config, { entry: 'src/main.c' });
    assert.equal(selected?.boardId, 'STM32F103C8T6');
    assert.equal(selected?.flashSize, 64 * 1024);
  }
  for (const device of ['STM32F103CB', 'STM32F103RB', 'STM32F103TB', 'STM32F407VG']) {
    await fs.writeFile(path.join(project, 'Project.uvprojx'), descriptor(device));
    await assert.rejects(compiler.projectDevice({ entry: 'src/main.c' }), /stm32CompilerProfileRequired/);
    await assert.rejects(
      runtime.projectConfig!(config, { entry: 'src/main.c' }),
      /stm32CompilerProfileRequired/,
    );
  }
  assert.equal(calls.length, 0, 'target classification does not invoke tools or access a device');
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
  await assert.rejects(compiler.build(config, { entry: 'src/main.c' }), /stm32CompilerMissing/);
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

test('native Arm startup falls back to GNU Arm only when a GNU compiler is present', async (t) => {
  const { compiler, project, config, root, calls } = await fixture(t);
  await fs.unlink(path.join(root, 'tools/armclang/bin', executable('armasm')));
  await fs.writeFile(
    path.join(project, 'src/startup.s'),
    'AREA RESET, DATA, READONLY\nEXPORT Reset_Handler\n',
  );
  await fs.writeFile(path.join(project, 'firmware.sct'), 'LR_FLASH 0x08000000 0x10000 {}');
  const gnuBin = path.join(root, 'tools/armgcc/bin');
  await fs.mkdir(gnuBin, { recursive: true });
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
    await fs.writeFile(path.join(gnuBin, executable(name)), 'fixture');
  const result = await compiler.build(config, { entry: 'src/main.c' });
  assert.match(result.output, /GNU Arm GCC/);
  assert.ok(!calls.some((call) => call.tool === 'armasm'));
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
  config.programmer!.serialNumber = '75010001230046504E413836';
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

test('GNU Arm builds with generated startup and linker script when Arm Compiler is absent', async (t) => {
  const { compiler, config, root, calls } = await fixture(t);
  await fs.rm(path.join(root, 'tools/armclang'), { recursive: true, force: true });
  const gnuBin = path.join(root, 'tools/armgcc/bin');
  await fs.mkdir(gnuBin, { recursive: true });
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
    await fs.writeFile(path.join(gnuBin, executable(name)), 'fixture');
  const status = await compiler.status(config);
  assert.deepEqual(status, { installed: true, version: '15.2.1', gnu: true });
  const result = await compiler.build(config, { entry: 'src/main.c' });
  assert.equal(result.flashUsed, 32);
  assert.match(result.output, /GNU Arm GCC/);
  assert.ok(calls.some((call) => call.tool === 'arm-none-eabi-gcc' && call.args.includes('-T')));
  assert.ok(calls.some((call) => call.tool === 'arm-none-eabi-objcopy'));
});

test('GNU startup and linker templates keep the partition boundary and stack budget', () => {
  const script = createF1GnuLinkerScript(0x10000, true);
  assert.match(script, /ENTRY\(Reset_Handler\)/);
  assert.match(script, /LENGTH = 0x10000/);
  assert.match(script, /_Min_Stack_Size = 0x400/);
  assert.match(script, /\.fwtag/);
  const startup = createF1GnuStartup();
  assert.match(startup, /__libc_init_array/);
  assert.match(startup, /\.isr_vector/);
  assert.match(startup, /Reset_Handler/);
});

test('per-language GNU pins select distinct installed versions and C++ links with its selected driver', async (t) => {
  const { compiler, config, root, project, calls } = await fixture(t);
  await fs.writeFile(path.join(project, 'src/extra.cpp'), 'int extra(){return 1;}');
  const c = path.join(root, 'tools/versions/gnu-arm/15.2.1-1.1');
  const cpp = path.join(root, 'tools/custom-cpp');
  for (const directory of [c, cpp]) {
    await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
    for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-g++', 'arm-none-eabi-objcopy'])
      await fs.writeFile(path.join(directory, 'bin', executable(name)), 'fixture');
  }
  const result = await compiler.build(config, {
    entry: 'src',
    settings: {
      common: { family: 'gnu-arm', version: '15.2.1-1.1' },
      platforms: { STM32F103C8T6: { cpp: { family: 'gnu-arm', directory: cpp } } },
      mode: 'debug',
      optimizeForSize: true,
    },
  });
  assert.equal(result.success, true);
  const cCall = calls.find((call) => call.args.includes(path.join(project, 'src/main.c')))!;
  const cppCall = calls.find((call) => call.args.includes(path.join(project, 'src/extra.cpp')))!;
  const linkCall = calls.find((call) => call.args.includes('-T'))!;
  assert.equal(path.dirname(cCall.command), path.join(c, 'bin'));
  assert.equal(path.dirname(cppCall.command), path.join(cpp, 'bin'));
  assert.equal(linkCall.command, path.join(cpp, 'bin', executable('arm-none-eabi-g++')));
  for (const call of [cCall, cppCall]) {
    assert.ok(call.args.includes('-O0'));
    assert.ok(call.args.includes('-g'));
    assert.ok(!call.args.includes('-Os'));
    assert.ok(!call.args.includes('-flto'));
  }
  assert.ok(linkCall.args.includes('-Wl,--gc-sections'));
});

test('explicit missing compiler pins fail instead of switching to installed AC6 or GNU', async (t) => {
  const { compiler, config, root, calls } = await fixture(t);
  for (const family of ['gnu-arm', 'armclang'] as const) {
    await assert.rejects(
      compiler.build(config, {
        entry: 'src',
        settings: { common: { family, directory: path.join(root, 'missing') } },
      }),
      /stm32CompilerMissing/,
    );
    await assert.rejects(
      compiler.build(config, { entry: 'src', settings: { common: { family, version: '0.0.0' } } }),
      /buildCompilerVersion/,
    );
  }
  assert.ok(
    calls.every((call) => call.args.includes('--version')),
    'version resolution never compiles with the wrong installed compiler',
  );
  await assert.rejects(
    compiler.build(config, {
      entry: 'src',
      settings: {
        common: { family: 'armclang', directory: path.join(root, 'tools/armclang'), version: '6.21' },
      },
    }),
    /buildCompilerVersion/,
  );
});

test('mixed compiler families are rejected and size mode can be disabled in release builds', async (t) => {
  const { compiler, config, root, project, calls } = await fixture(t);
  const gnu = path.join(root, 'tools/gnu');
  await fs.mkdir(gnu, { recursive: true });
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
    await fs.writeFile(path.join(gnu, executable(name)), 'fixture');
  await fs.writeFile(path.join(project, 'src/extra.cpp'), 'int extra(){return 1;}');
  await assert.rejects(
    compiler.build(config, {
      entry: 'src',
      settings: {
        platforms: {
          STM32F103C8T6: { c: { family: 'gnu-arm', directory: gnu }, cpp: { family: 'armclang' } },
        },
      },
    }),
    /buildCompilerMixedFamilies/,
  );
  await compiler.build(config, { entry: 'src', settings: { mode: 'release', optimizeForSize: false } });
  const compilation = calls.filter((call) => call.tool === 'armclang' && call.args.includes('-c'));
  assert.ok(compilation.length > 0);
  assert.ok(compilation.every((call) => call.args.includes('-O2') && !call.args.includes('-Os')));
});

test('portable version pins match managed/PATH versions and package-suffixed version stores', async (t) => {
  const { compiler, config, root, calls, host } = await fixture(t);
  const gnu = path.join(root, 'tools/armgcc/bin');
  await fs.mkdir(gnu, { recursive: true });
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
    await fs.writeFile(path.join(gnu, executable(name)), 'fixture');
  const build = { entry: 'src', settings: { common: { family: 'gnu-arm' as const, version: '15.2.1' } } };
  assert.equal((await compiler.build(config, build)).success, true);
  assert.equal(
    path.dirname(
      calls.find((call) => call.tool === 'arm-none-eabi-gcc' && call.args.includes('-c'))!.command,
    ),
    gnu,
  );
  assert.equal(
    (
      await compiler.build(config, {
        entry: 'src',
        settings: { common: { family: 'armclang', version: '6.22' } },
      })
    ).success,
    true,
  );
  const versioned = path.join(root, 'tools/versions/gnu-arm/15.2.1-1.1/bin');
  await fs.mkdir(path.dirname(path.dirname(versioned)), { recursive: true });
  await fs.rename(path.dirname(gnu), path.dirname(versioned));
  calls.length = 0;
  assert.equal((await compiler.build(config, build)).success, true);
  assert.equal(
    path.dirname(
      calls.find((call) => call.tool === 'arm-none-eabi-gcc' && call.args.includes('-c'))!.command,
    ),
    versioned,
  );
  const pathBin = path.join(root, 'path-gnu');
  await fs.rename(versioned, pathBin);
  host.env = { PATH: pathBin };
  calls.length = 0;
  assert.equal((await compiler.build(config, build)).success, true);
  assert.equal(
    path.dirname(
      calls.find((call) => call.tool === 'arm-none-eabi-gcc' && call.args.includes('-c'))!.command,
    ),
    pathBin,
  );
});

test('managed GNU Arm rejects a release whose digest does not match', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-gnu-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('archive fixture');
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url === GNU_WINDOWS_RELEASE.metadataUrl)
      return new Response(
        JSON.stringify({
          tag_name: GNU_WINDOWS_RELEASE.version,
          assets: [
            {
              name: GNU_WINDOWS_RELEASE.asset,
              browser_download_url: GNU_WINDOWS_RELEASE.downloadUrl,
              digest: `sha256:${'0'.repeat(64)}`,
              size: bytes.length,
            },
          ],
        }),
        { status: 200 },
      );
    return new Response(bytes, { status: 200 });
  };
  const tool = new GnuArmToolchain({
    root,
    fetcher: fetcher as typeof fetch,
    runner: async () => ({ code: 0, output: '' }),
  });
  await assert.rejects(tool.install(), /gnuChecksum/);
  assert.deepEqual(await fs.readdir(root).catch(() => []), []);
});
