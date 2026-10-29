import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RuntimeHost } from '../extensions/runtime';
import { Stm32Compiler } from '../extensions/boards/STM32F103C8T6/compiler/index';
import { createStm32Runtime } from '../extensions/boards/STM32F103C8T6/runtime/index';
import { stm32Adapter } from '../extensions/boards/STM32F103C8T6/device/adapter';

const executable = (name: string) => name + (process.platform === 'win32' ? '.exe' : '');

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-compiler-status-'));
  const tools = path.join(root, 'tools');
  const calls: string[] = [];
  let brokenGnu = false;
  const host: RuntimeHost = {
    dataRoot: path.join(root, 'data'),
    toolchainRoot: tools,
    signal: new AbortController().signal,
    env: { PATH: '' },
    emit() {},
    projectRoot: () => root,
    readProjectFiles: async () => [],
    resolveWorkspacePath: async () => {
      throw new Error('must not access a workspace');
    },
    resetDirectory: async () => {
      throw new Error('must not compile');
    },
    listPorts: async () => [],
    requirePort: async () => {
      throw new Error('must not use a device');
    },
    closeSerial: async () => {},
    runCommand: async (command, args) => {
      assert.deepEqual(args, ['--version']);
      const tool = path.basename(command).replace(/\.exe$/i, '');
      calls.push(tool);
      if (tool === 'armclang') return { code: 0, output: 'Arm Compiler for Embedded 6.22' };
      assert.equal(tool, 'arm-none-eabi-gcc');
      return brokenGnu
        ? { code: 1, output: 'cannot run GNU compiler' }
        : { code: 0, output: 'arm-none-eabi-gcc (GNU) 15.2.1' };
    },
  };
  const install = async (directory: string, names: string[]) => {
    await fs.mkdir(directory, { recursive: true });
    for (const name of names) await fs.writeFile(path.join(directory, executable(name)), 'fixture');
  };
  const ac6 = path.join(tools, 'armclang/bin');
  const gnu = path.join(tools, 'armgcc/bin');
  const runtime = createStm32Runtime(host, {
    status: async () => ({ installed: true, version: '1.9.0' }),
    listProbes: async () => [],
    probe: async () => {
      throw new Error('must not probe');
    },
    flash: async () => {
      throw new Error('must not flash');
    },
    install: async () => {
      throw new Error('must not download');
    },
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return {
    tools,
    ac6,
    gnu,
    host,
    runtime,
    calls,
    config: stm32Adapter.createConfig(),
    compiler: new Stm32Compiler(host),
    installAc6: () => install(ac6, ['armclang', 'armlink', 'fromelf']),
    installGnu: (directory = gnu) => install(directory, ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy']),
    breakGnu: () => {
      brokenGnu = true;
    },
  };
}

test('AC6 and GNU installations report their own versions while compilation keeps AC6 priority', async (t) => {
  const f = await fixture(t);
  await f.installAc6();
  await f.installGnu();
  const status = await f.runtime.status(f.config);
  assert.equal(status.armCompiler, true);
  assert.equal(status.gnuArm, true);
  assert.equal(status.versions.armCompiler, '6.22');
  assert.equal(status.versions.gnuArm, '15.2.1');
  assert.deepEqual(await f.compiler.status(f.config), { installed: true, version: '6.22', gnu: false });
  f.config.toolchain.armCompilerDirectory = f.gnu;
  assert.deepEqual(await f.compiler.status(f.config), { installed: true, version: '15.2.1', gnu: true });
  const selectedGnu = await f.runtime.status(f.config);
  assert.equal(selectedGnu.armCompiler, true);
  assert.equal(selectedGnu.gnuArm, true);
});

test('installing GNU after an AC6-only status immediately changes the next status result', async (t) => {
  const f = await fixture(t);
  await f.installAc6();
  assert.equal((await f.runtime.status(f.config)).gnuArm, false);
  await f.installGnu();
  const status = await f.runtime.status(f.config);
  assert.equal(status.gnuArm, true);
  assert.equal(status.armCompiler, true);
});

test('an unselected side-by-side GNU version is installed without changing build selection', async (t) => {
  const f = await fixture(t);
  await f.installAc6();
  const version = path.join(f.tools, 'versions/gnu-arm/15.2.1-1.1/bin');
  await f.installGnu(version);
  const status = await f.runtime.status(f.config);
  assert.equal(status.gnuArm, true);
  assert.equal(status.versions.gnuArm, '15.2.1');
  assert.deepEqual(await f.compiler.status(f.config), { installed: true, version: '6.22', gnu: false });
  f.config.toolchain.armCompilerDirectory = version;
  assert.equal((await f.compiler.status(f.config)).gnu, true);
});

test('a broken explicit directory remains invalid for selection while other installations stay visible', async (t) => {
  const f = await fixture(t);
  await f.installAc6();
  f.config.toolchain.armCompilerDirectory = path.join(f.tools, 'missing');
  assert.equal((await f.compiler.status(f.config)).installed, false);
  const status = await f.runtime.status(f.config);
  assert.equal(status.armCompiler, true);
  assert.equal(status.gnuArm, false);
  assert.equal(status.versions.armCompiler, '6.22');
});

test('failed GNU version checks do not erase a working AC6 or report GNU as installed', async (t) => {
  const f = await fixture(t);
  await f.installAc6();
  await f.installGnu();
  f.breakGnu();
  const status = await f.runtime.status(f.config);
  assert.equal(status.armCompiler, true);
  assert.equal(status.gnuArm, false);
  assert.equal(status.versions.armCompiler, '6.22');
  assert.equal(status.versions.gnuArm, undefined);
});

test('ST-Link discovery never starts compiler installation status checks', async (t) => {
  const f = await fixture(t);
  await f.installAc6();
  await f.installGnu();
  assert.deepEqual(await f.runtime.discover(f.config), []);
  assert.deepEqual(f.calls, []);
});
