import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getBoardAdapter } from '../extensions/registry';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { debuggerServerArguments, debuggerSegmentKind } from '../src/core/debugger-target';
import { debuggerProfiles } from '../src/shared/debugger-profiles';
import { parseConfig } from '../src/core/config';
import { createWebDebugger } from '../src/core/web-debugger';
import type { CoreService } from '../src/core/service';
import { GnuArmToolchain } from '../extensions/boards/STM32F103C8T6/tools/gnu';

const esp = () => getBoardAdapter('Esp32_S3_CAM').createConfig();
const arm = () => getBoardAdapter('STM32F103C8T6').createConfig();
function elf(machine: number, address: number) {
  const bytes = Buffer.alloc(84);
  bytes.write('7f454c46', 'hex');
  bytes[4] = bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(52, 28);
  bytes.writeUInt16LE(32, 42);
  bytes.writeUInt16LE(1, 44);
  bytes.writeUInt32LE(1, 52);
  bytes.writeUInt32LE(address, 60);
  bytes.writeUInt32LE(16, 72);
  return bytes;
}

test('debugger registry separates Cortex-M and Xtensa registers, instruction editors and memory mappings', () => {
  const xtensa = debuggerProfiles.Esp32_S3_CAM;
  assert.equal(xtensa.elfMachine, 94);
  assert.equal(xtensa.canAssemble, false);
  assert.equal(xtensa.canPatchInstructions, false);
  assert.equal(xtensa.stackPointer, 'a1');
  assert.ok(xtensa.registerNames.includes('ps'));
  assert.ok(xtensa.registerNames.includes('sar'));
  assert.equal(debuggerSegmentKind(xtensa, 0x40370000, 16), 'ram');
  assert.equal(debuggerSegmentKind(xtensa, 0x3fc88000, 16), 'ram');
  assert.equal(debuggerSegmentKind(xtensa, 0x42000000, 16), 'flash');
  assert.equal(debuggerSegmentKind(xtensa, 0x20000000, 16), 'other');
  assert.equal(debuggerProfiles.STM32F103C8T6.canPatchInstructions, true);
  assert.ok(getBoardAdapter('Esp32_S3_CAM').definition.capabilities.includes('debug'));
  assert.equal(getBoardAdapter('Esp32_S3_CAM').definition.runtimePlugin?.debugger.mode, 'builtin');
});

test('ESP USB-JTAG server uses builtin configuration with localhost-only attach and no flash reset/emulation', () => {
  const config = esp();
  config.debugger = { serialNumber: '60:55:F9:00:01:02', frequencyKhz: 15000 };
  const args = debuggerServerArguments(debuggerProfiles.Esp32_S3_CAM, config, 45001, '/openocd/scripts');
  for (const expected of [
    'bindto 127.0.0.1',
    'gdb port 45001',
    'tcl port disabled',
    'telnet port disabled',
    'set ESP_FLASH_SIZE 0',
    'board/esp32s3-builtin.cfg',
    'adapter serial {60:55:F9:00:01:02}',
    'adapter speed 15000',
  ])
    assert.ok(args.includes(expected), expected);
  assert.ok(args.indexOf('set ESP_FLASH_SIZE 0') < args.indexOf('board/esp32s3-builtin.cfg'));
  assert.equal(
    args.some((arg) => /reset|program_esp|flash write/.test(arg)),
    false,
  );
  assert.throws(
    () => debuggerServerArguments(debuggerProfiles.Esp32_S3_CAM, config, 0, '/scripts'),
    /invalidArguments/,
  );
  assert.throws(
    () => debuggerServerArguments(debuggerProfiles.Esp32_S3_CAM, config, 3333),
    /debuggerEspScripts/,
  );
  config.debugger.serialNumber = 'x}; shutdown';
  assert.throws(
    () => debuggerServerArguments(debuggerProfiles.Esp32_S3_CAM, config, 3333, '/scripts'),
    /invalidArguments/,
  );
});

test('STM32 keeps its existing st-util serial/frequency/no-reset launch', () => {
  const config = arm();
  config.programmer = { transport: 'stlink', serialNumber: 'ABCD', frequencyKhz: 1800 };
  assert.deepEqual(debuggerServerArguments(debuggerProfiles.STM32F103C8T6, config, 45000), [
    '-m',
    '--no-reset',
    '--serial',
    'ABCD',
    '-p',
    '45000',
    '-F',
    '1800k',
  ]);
});

test('debugger config preserves tool paths separately from compiler and serial monitor fields', () => {
  const config = esp();
  config.port = 'COM5';
  config.debugger = {
    gdbPath: 'C:/tools/xtensa-esp-elf-gdb.exe',
    serverPath: 'C:/tools/openocd.exe',
    scriptsPath: 'C:/tools/scripts',
    serialNumber: 'AA:BB:CC',
    frequencyKhz: 20000,
  };
  const parsed = parseConfig(config);
  assert.deepEqual(parsed.debugger, config.debugger);
  assert.equal(parsed.port, 'COM5');
  assert.throws(() => parseConfig({ ...config, debugger: { serialNumber: 'x\nexit' } }), /invalidConfig/);
});

test('ELF selection follows target architecture and retains separate symbols for both platforms', async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-debug-profiles-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const debug = new HardwareDebugger(root, root);
  t.mock.method(debug as any, 'tools', async () => ({ gdb: 'gdb', server: 'server', scripts: 'scripts' }));
  await debug.state(arm());
  await debug.symbolsBytes(elf(40, 0x20000000), 'arm.elf');
  await debug.state(esp());
  assert.equal((await debug.state()).symbols, '');
  await assert.rejects(debug.symbolsBytes(elf(40, 0x20000000), 'wrong.elf'), /debuggerElfArchitecture/);
  await debug.symbolsBytes(elf(94, 0x40370000), 'esp.elf');
  assert.equal((await debug.storage())?.segments[0].kind, 'ram');
  assert.equal((await debug.state()).profile?.architecture, 'xtensa');
  await assert.rejects(debug.assemble(0x40370000, 'nop'), /debuggerArchitectureUnsupported/);
  await assert.rejects(
    debug.patch({
      sessionId: 'old',
      address: 0x20000000,
      bytes: '00bf',
      expected: '00bf',
      pauseAndResume: false,
      confirm: true,
    }),
    /debuggerArchitectureUnsupported/,
  );
  await debug.state(arm());
  assert.equal((await debug.state()).symbols, 'arm.elf');
  assert.equal((await debug.storage())?.segments[0].kind, 'ram');
});

test('an active debugger pins its target when another client asks for a different profile', async (t) => {
  const debug = new HardwareDebugger('.', '.');
  t.mock.method(debug as any, 'tools', async () => ({ gdb: 'gdb', server: 'server', scripts: 'scripts' }));
  await debug.state(esp());
  (debug as any).gdb = { stdin: { end() {} } };
  const result = await debug.state(arm());
  assert.equal(result.profile?.id, 'Esp32_S3_CAM');
  await debug.disconnect();
});

test('ESP breakpoints explicitly use hardware slots and cannot trigger flash software patches', async (t) => {
  const debug = new HardwareDebugger('.', '.');
  t.mock.method(debug as any, 'tools', async () => ({ gdb: 'gdb', server: 'server', scripts: 'scripts' }));
  await debug.state(esp());
  const commands: string[] = [];
  (debug as any).snapshot.connection = 'stopped';
  t.mock.method(debug as any, 'command', async (command: string) => {
    commands.push(command);
    return { bkpt: { number: '1' } };
  });
  await debug.breakpoint('app_main');
  assert.deepEqual(commands, ['-break-insert -h "app_main"']);
});

test('web state and installation accept the selected target without requiring a serial monitor port', async () => {
  const calls: unknown[] = [];
  const debug = {
    state: async (config: unknown) => calls.push(config),
    install: async (_p: unknown, _l: unknown, options: { config?: unknown }) => calls.push(options.config),
  } as unknown as HardwareDebugger;
  const core = {
    runInstallation: async (_name: string, run: (args: object) => unknown) => run({}),
  } as unknown as CoreService;
  const routes = createWebDebugger(debug, core);
  await routes.invoke('debuggerState', []);
  await routes.invoke('debuggerState', [esp()]);
  await routes.invoke('debuggerInstallTools', [esp()]);
  assert.deepEqual(calls, [undefined, esp(), esp()]);
});

test('tool state distinguishes a missing OpenOCD executable from a missing script directory', async (t) => {
  const debug = new HardwareDebugger('.', '.');
  let found = { gdb: '/tools/xtensa-gdb', server: '/tools/openocd', scripts: null as string | null };
  t.mock.method(debug as any, 'tools', async () => found);
  const missingScripts = await debug.state(esp());
  assert.equal(missingScripts.tools.server, false);
  assert.deepEqual(missingScripts.tools.paths, found);
  found = { ...found, scripts: '/tools/scripts' };
  const ready = await debug.state();
  assert.equal(ready.tools.server, true);
  assert.equal(ready.tools.paths?.scripts, '/tools/scripts');
  t.mock.method(debug as any, 'tools', async () => ({ gdb: null, server: null, scripts: null }));
  const absent = await debug.state();
  assert.equal(absent.tools.server, false);
  assert.equal(absent.tools.paths?.server, null);
});

test('an installation validates its original profile even if another client switches target while downloading', async (t) => {
  const debug = new HardwareDebugger('.', '.');
  let startInstall!: () => void, finishInstall!: () => void;
  const started = new Promise<void>((resolve) => {
    startInstall = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finishInstall = resolve;
  });
  const checked: string[] = [];
  t.mock.method(GnuArmToolchain.prototype, 'install', async () => {
    startInstall();
    await release;
  });
  t.mock.method(debug as any, 'tools', async (_config: unknown, profile: { id: string }) => {
    checked.push(profile.id);
    return { gdb: profile.id === 'STM32F103C8T6' ? '/tools/gdb' : null, server: null, scripts: null };
  });
  const install = debug.install(undefined, undefined, { config: arm() });
  await started;
  await debug.state(esp());
  finishInstall();
  await install;
  assert.equal(checked.at(-1), 'STM32F103C8T6');
  assert.equal((await debug.state()).profile?.id, 'Esp32_S3_CAM');
});

test('GDB selection rejects a target change while the native file picker was open', async (t) => {
  const debug = new HardwareDebugger('.', '.');
  t.mock.method(debug as any, 'tools', async () => ({ gdb: null, server: null, scripts: null }));
  await debug.state(arm());
  const original = (await debug.state()).profile!.id;
  await debug.state(esp());
  await assert.rejects(debug.selectGdb('/arm-none-eabi-gdb', original), /debuggerSessionChanged/);
});
