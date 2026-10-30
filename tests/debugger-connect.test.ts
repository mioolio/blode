import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { getBoardAdapter } from '../extensions/registry';

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
  const input=readline.createInterface({input:process.stdin});
  input.on('close',()=>process.exit(0));
  input.on('line',line=>{
    const [,id,command]=/^(\\d+)(.*)$/.exec(line);
    let result='done';
    if(command.startsWith('-target-select')) {
      result='connected';
    } else if(command==='-data-list-register-names') {
      if(mode==='late-stop'&&!lateStop) {
        lateStop=true;
        process.stdout.write('*stopped,reason="signal-received",signal-name="SIGTRAP",thread-id="1"\\n');
      }
      result='done,register-names=["pc","a0","a1","ps"]';
    } else if(command==='-data-list-register-values x') {
      result='done,register-values=[{number="0",value="0x40370000"},{number="1",value="0"},{number="2",value="0x3fc90000"},{number="3",value="0x60020"}]';
    } else if(command.startsWith('-data-disassemble')) result='done,asm_insns=[]';
    else if(command.startsWith('-stack-list-frames')) result='done,stack=[]';
    process.stdout.write(id+'^'+result+'\\n');
  });
}
`;

async function fixture(t: TestContext, mode: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-debug-connect-'));
  const script = path.join(root, 'debug-tools.mjs');
  await fs.writeFile(script, childSource);
  const debug = new HardwareDebugger(root, root);
  const calls: { command: string; args: string[] }[] = [];
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
  return { debug, config, calls, started };
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
