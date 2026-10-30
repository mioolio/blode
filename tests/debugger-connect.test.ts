import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { getBoardAdapter } from '../extensions/registry';
import { openUartGdbBridge } from '../extensions/boards/Esp32_S3_CAM/debugger/uart-gdb';
import { FakeUart, rsp } from './helpers/uart-gdb-fake';
import type { AutomaticDebugSymbolResolver } from '../src/core/build-debug-symbols';

const childSource = `
import net from 'node:net';
import readline from 'node:readline';
const [kind,mode,...args]=process.argv.slice(2);
if(kind==='server') {
  if(mode==='server-failure') {
    process.stderr.write('Error: esp_usb_jtag: LIBUSB_ERROR_NOT_SUPPORTED\\n',()=>process.exit(1));
  } else if(mode==='cancel') {
    setInterval(()=>{},1000);
  } else {
    const port=Number(args.find(value=>value.startsWith('gdb port ')).split(' ')[2]);
    net.createServer(socket=>socket.end()).listen(port,'127.0.0.1');
  }
} else if(mode==='gdb-failure') {
  process.stderr.write('GDB: required Python DLL is missing\\n',()=>process.exit(2));
} else {
  let lateStop=false;
  let wire;
  const input=readline.createInterface({input:process.stdin});
  input.on('close',()=>process.exit(0));
  input.on('line',line=>{
    const [,id,command]=/^(\\d+)(.*)$/.exec(line);
    let result='done';
    if(command.startsWith('-target-select')) {
      if(mode.startsWith('uart')) {
        const port=Number(command.split(':').at(-1));
        wire=net.connect(port,'127.0.0.1');
        wire.once('data',()=>{
          wire.write('+');
          process.stdout.write(id+'^connected\\n');
        });
        return;
      }
      result='connected';
    } else if(command.startsWith('-break-insert')) {
      result='done,bkpt={number="1"}';
    } else if(command==='-target-disconnect') {
      wire?.end();
    } else if(command==='-exec-continue') {
      result='running';
    } else if(command==='-exec-interrupt --all') {
      process.stdout.write('*stopped,reason="signal-received",signal-name="SIGINT"\\n');
    } else if(command==='-data-list-register-names') {
      if(mode==='late-stop'&&!lateStop) {
        lateStop=true;
        process.stdout.write('*stopped,reason="signal-received",signal-name="SIGTRAP",thread-id="1"\\n');
      }
      result='done,register-names=["pc","a0","a1","ps","f0"]';
    } else if(command.startsWith('-data-list-register-values x')) {
      result='done,register-values=[{number="0",value="0x40370000"},{number="1",value="0"},{number="2",value="0x3fc90000"},{number="3",value="0x60020"},{number="4",value="0xff"}]';
    } else if(command.startsWith('-data-disassemble')) result='done,asm_insns=[]';
    else if(command.startsWith('-stack-list-frames')) result='done,stack=[]';
    process.stdout.write(id+'^'+result+'\\n');
  });
}
`;

async function fixture(t: TestContext, mode: string, automaticSymbols?: AutomaticDebugSymbolResolver) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-debug-connect-'));
  const script = path.join(root, 'debug-tools.mjs');
  await fs.writeFile(script, childSource);
  const debug = new HardwareDebugger(root, root, undefined, automaticSymbols);
  const calls: { command: string; args: string[] }[] = [];
  const commands: string[] = [];
  const children: Promise<void>[] = [];
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  t.mock.method(debug as any, 'tools', async () => ({ gdb: 'gdb', server: 'server', scripts: root }));
  t.mock.method(debug as any, 'probeUsbJtag', async () => {});
  t.mock.method(debug as any, 'spawnProcess', (command: string, args: string[], options: object) => {
    calls.push({ command, args });
    const child = spawn(process.execPath, [script, command, mode, ...args], options);
    if (command === 'gdb') {
      const write = child.stdin!.write.bind(child.stdin!);
      child.stdin!.write = ((chunk: any, ...rest: any[]) => {
        commands.push(String(chunk).replace(/^\d+/, '').trim());
        return (write as any)(chunk, ...rest);
      }) as any;
    }
    children.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
    signalStarted();
    return child;
  });
  t.after(async () => {
    await debug.disconnect();
    await Promise.all(children);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-debug-connect-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  config.debugger = { serialNumber: '' };
  return { debug, config, calls, commands, started };
}

test('ESP USB-JTAG connects with blank serial through a real local server and MI child process', async (t) => {
  const f = await fixture(t, 'success');
  await f.debug.connect(f.config);
  const state = await f.debug.state();
  assert.equal(state.connection, 'stopped');
  assert.equal(state.programCounter, '0x40370000');
  assert.equal(state.message, '');
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls[0].args.some((arg) => arg.startsWith('adapter serial')),
    false,
  );
});

test('native connect loads the current automatic ELF before attach and never revives a retired target ELF', async (t) => {
  const elf = Buffer.alloc(84);
  elf.write('7f454c46', 'hex');
  elf[4] = elf[5] = 1;
  elf.writeUInt16LE(94, 18);
  let current: { id: string; name: string; bytes: Buffer } | null = {
    id: 'camera-build-1',
    name: 'camera.ino.elf',
    bytes: elf,
  };
  const f = await fixture(t, 'success', async () => current);
  await f.debug.connect(f.config);
  assert.equal((await f.debug.state()).symbols, 'camera.ino.elf');
  const symbolIndex = f.commands.findIndex((command) => command.startsWith('-file-exec-and-symbols '));
  assert.ok(symbolIndex >= 0);
  assert.ok(symbolIndex < f.commands.findIndex((command) => command.startsWith('-target-select')));
  await f.debug.disconnect();
  current = null;
  const firstCount = f.commands.filter((command) => command.startsWith('-file-exec-and-symbols ')).length;
  await f.debug.connect(f.config);
  assert.equal((await f.debug.state()).symbols, '');
  assert.equal(
    f.commands.filter((command) => command.startsWith('-file-exec-and-symbols ')).length,
    firstCount,
  );
  await f.debug.disconnect();
  await f.debug.symbolsBytes(elf, 'manual.elf');
  current = { id: 'camera-build-2', name: 'other.elf', bytes: elf };
  await f.debug.connect(f.config);
  assert.equal((await f.debug.state()).symbols, 'manual.elf');
});

test('cancelling a pending automatic ELF read cannot launch a debugger or restore the retired selection', async (t) => {
  let started!: () => void, finish!: (value: any) => void;
  const waiting = new Promise<void>((resolve) => (started = resolve)),
    pending = new Promise<any>((resolve) => (finish = resolve));
  const f = await fixture(t, 'success', async () => {
    started();
    return pending;
  });
  const connecting = f.debug.connect(f.config),
    cancelled = assert.rejects(connecting, /operationCancelled/);
  await waiting;
  await f.debug.disconnect();
  const bytes = Buffer.alloc(84);
  bytes.write('7f454c46', 'hex');
  bytes[4] = bytes[5] = 1;
  bytes.writeUInt16LE(94, 18);
  finish({ id: 'late-target', name: 'late.elf', bytes });
  await cancelled;
  assert.equal(f.calls.length, 0);
  assert.equal((f.debug as any).symbols, '');
});

test('late target stop notifications refresh the same session instead of rejecting a valid connection', async (t) => {
  const f = await fixture(t, 'late-stop');
  await f.debug.connect(f.config);
  assert.equal((await f.debug.state()).connection, 'stopped');
  assert.equal((await f.debug.state()).programCounter, '0x40370000');
});

test('server startup failure preserves the final USB driver diagnostic instead of session changed', async (t) => {
  const f = await fixture(t, 'server-failure');
  await assert.rejects(f.debug.connect(f.config), /LIBUSB_ERROR_NOT_SUPPORTED/);
  const state = await f.debug.state();
  assert.equal(state.connection, 'error');
  assert.match(state.message, /LIBUSB_ERROR_NOT_SUPPORTED/);
  assert.equal(f.calls.length, 1);
});

test('GDB process startup errors retain stderr instead of the pending command disconnected error', async (t) => {
  const f = await fixture(t, 'gdb-failure');
  await assert.rejects(f.debug.connect(f.config), /required Python DLL is missing/);
  assert.match((await f.debug.state()).message, /required Python DLL is missing/);
});

test('explicit cancellation while waiting for the server is distinct from startup failure', async (t) => {
  const f = await fixture(t, 'cancel');
  const connecting = f.debug.connect(f.config);
  const rejection = assert.rejects(connecting, /error.operationCancelled/);
  await f.started;
  await f.debug.disconnect();
  await rejection;
  const state = await f.debug.state();
  assert.equal(state.connection, 'disconnected');
  assert.equal(state.message, '');
});

test('confirmed USB-JTAG preflight failure starts neither OpenOCD nor GDB', async (t) => {
  const f = await fixture(t, 'success');
  t.mock.method(f.debug as any, 'probeUsbJtag', async () => {
    throw Error('error.debuggerUsbJtagMissing');
  });
  await assert.rejects(f.debug.connect(f.config), /debuggerUsbJtagMissing/);
  assert.equal(f.calls.length, 0);
});

test('missing tools are reported before any USB preflight starts', async (t) => {
  const f = await fixture(t, 'success');
  let checked = false;
  t.mock.method(f.debug as any, 'tools', async () => ({ gdb: null, server: null, scripts: null }));
  t.mock.method(f.debug as any, 'probeUsbJtag', async () => {
    checked = true;
  });
  await assert.rejects(f.debug.connect(f.config), /debuggerToolsMissing/);
  assert.equal(checked, false);
  assert.equal(f.calls.length, 0);
});

test('cancelling during USB enumeration cannot launch a late OpenOCD process', async (t) => {
  const f = await fixture(t, 'success');
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let pendingSignal: AbortSignal | undefined;
  t.mock.method(
    f.debug as any,
    'probeUsbJtag',
    async (_config: unknown, _profile: unknown, signal: AbortSignal) => {
      pendingSignal = signal;
      enter();
      await complete;
    },
  );
  const connecting = f.debug.connect(f.config);
  const cancelled = assert.rejects(connecting, /operationCancelled/);
  await entered;
  await f.debug.disconnect();
  assert.equal(pendingSignal?.aborted, true);
  finish();
  await cancelled;
  assert.equal(f.calls.length, 0);
});

async function uartFixture(t: TestContext, mode: 'runtime' | 'panic' = 'runtime') {
  const f = await fixture(t, 'uart-' + mode);
  f.config.debugger = { transport: 'uart-gdb', port: 'COM3', baudRate: 115200, stubMode: mode };
  const serial = new FakeUart();
  serial.onWrite = (bytes) => {
    if (bytes[0] === 3 || bytes.equals(rsp('?'))) serial.receive(rsp('T05thread:1;'));
  };
  t.mock.method(f.debug as any, 'tools', async () => ({ gdb: 'gdb', server: null, scripts: null }));
  t.mock.method(f.debug as any, 'uartGdbEnvironment', async () => ({ ...process.env }));
  t.mock.method(f.debug as any, 'probeUsbJtag', async () => {
    assert.fail('UART must not probe native USB');
  });
  t.mock.method(f.debug as any, 'openUartBridge', (options: any) =>
    openUartGdbBridge({ ...options, createSerial: () => serial }),
  );
  return { ...f, serial };
}

test('UART runtime connects through a binary bridge and MI child with GDB only, then releases the port', async (t) => {
  const f = await uartFixture(t);
  await f.debug.connect(f.config);
  assert.equal(f.debug.ownedSerialPort, 'COM3');
  const state = await f.debug.state();
  assert.equal(state.connection, 'stopped');
  assert.equal(state.profile?.transport, 'uart-gdb');
  assert.equal(state.profile?.capabilities?.continue, true);
  assert.equal(state.tools.server, true);
  assert.equal(state.tools.paths?.server, null);
  assert.equal(
    state.registers.some((register) => register.name === 'f0'),
    false,
  );
  assert.deepEqual(
    f.calls.map((call) => call.command),
    ['gdb'],
  );
  assert.ok(f.commands.some((command) => command.startsWith('-target-select remote ')));
  assert.ok(f.commands.includes('-gdb-set remote software-breakpoint-packet on'));
  assert.ok(f.commands.includes('-gdb-set remote thread-events-packet off'));
  assert.ok(f.commands.includes('-data-list-register-values x 0 1 2 3'));
  await f.debug.breakpoint('main');
  assert.ok(f.commands.includes('-break-insert "main"'));
  assert.equal(
    f.commands.some((command) => command.startsWith('-break-insert -h')),
    false,
  );
  await f.debug.action('continue');
  assert.equal((await f.debug.state()).connection, 'running');
  await f.debug.action('pause');
  assert.equal((await f.debug.state()).connection, 'stopped');
  f.serial.closeDelay = 25;
  const closing = f.debug.disconnect();
  assert.equal(f.debug.ownedSerialPort, 'COM3');
  await closing;
  assert.equal(f.debug.ownedSerialPort, undefined);
  assert.equal(f.serial.isOpen, false);
  assert.ok(f.commands.includes('-target-disconnect'));
  assert.equal(
    f.commands.some((command) => /reset|target-detach|exec-abort/.test(command)),
    false,
  );
});

test('UART panic mode samples the stopped target and rejects execution and breakpoint changes', async (t) => {
  const f = await uartFixture(t, 'panic');
  await f.debug.connect(f.config);
  const state = await f.debug.state();
  assert.equal(state.connection, 'stopped');
  assert.equal(state.profile?.capabilities?.breakpoints, false);
  const count = f.commands.length;
  for (const action of ['continue', 'pause', 'step', 'next', 'finish'] as const)
    await assert.rejects(f.debug.action(action), /debuggerUartReadOnly/);
  await assert.rejects(f.debug.breakpoint('main'), /debuggerUartReadOnly/);
  assert.equal(f.commands.length, count);
  assert.equal(
    f.serial.writes.some((bytes) => bytes.includes(3)),
    false,
  );
});

test('UART firmware handshake timeout reports the real cause without starting GDB', async (t) => {
  const f = await uartFixture(t);
  f.serial.onWrite = () => f.serial.receive('application log\n');
  t.mock.method(f.debug as any, 'openUartBridge', (options: any) =>
    openUartGdbBridge({ ...options, timeoutMs: 25, createSerial: () => f.serial }),
  );
  await assert.rejects(f.debug.connect(f.config), /debuggerUartStubTimeout/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.debug.ownedSerialPort, undefined);
  assert.equal(f.serial.isOpen, false);
  assert.equal((await f.debug.state()).connection, 'error');
});

test('UART cancellation during open retains ownership until the late port is closed', async (t) => {
  const f = await uartFixture(t);
  f.serial.openDelay = 25;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(f.debug as any, 'openUartBridge', (options: any) => {
    entered();
    return openUartGdbBridge({ ...options, createSerial: () => f.serial });
  });
  const connecting = f.debug.connect(f.config);
  const rejected = assert.rejects(connecting, /operationCancelled/);
  await entering;
  await f.debug.disconnect();
  assert.equal(f.debug.ownedSerialPort, 'COM3');
  await rejected;
  assert.equal(f.debug.ownedSerialPort, undefined);
  assert.equal(f.serial.isOpen, false);
  assert.equal(f.calls.length, 0);
});
