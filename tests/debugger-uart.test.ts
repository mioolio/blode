import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import {
  openUartGdbBridge,
  uartGdbStopPacket,
  validateUartGdbOptions,
} from '../extensions/boards/Esp32_S3_CAM/debugger/uart-gdb';
import { FakeUart, rsp } from './helpers/uart-gdb-fake';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { esp32UartGdbEnvironment } from '../extensions/boards/Esp32_S3_CAM/debugger/uart-gdb-config';

const options = { port: 'COM3', baudRate: 115200, stubMode: 'runtime' as const, timeoutMs: 1000 };
async function connect(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  return socket;
}
async function until(predicate: () => boolean) {
  for (let i = 0; !predicate() && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(predicate());
}

test('UART stop scanner requires complete valid RSP, not logs, corrupted checksum or high-bit lookalikes', () => {
  assert.equal(uartGdbStopPacket(Buffer.from('booting $T05#00')), -1);
  assert.equal(uartGdbStopPacket(Buffer.concat([Buffer.from('boot\n'), rsp('T05thread:1;')])), 5);
  assert.equal(uartGdbStopPacket(rsp('S05').subarray(0, -1)), -1);
  assert.equal(uartGdbStopPacket(rsp('OK')), -1);
  assert.equal(uartGdbStopPacket(rsp(Buffer.from([0xd3, 0x30, 0x35]))), -1);
});

test('UART bridge validates paths and settings before opening a port', async () => {
  for (const port of ['', 'COM0', 'COM3\n', '/dev/../tmp/pipe', '\\\\server\\pipe'])
    assert.throws(() => validateUartGdbOptions({ ...options, port }), /debuggerUartPort/);
  assert.throws(() => validateUartGdbOptions({ ...options, baudRate: 0 }), /invalidBaudRate/);
  validateUartGdbOptions({ ...options, port: '/dev/ttyUSB0' });
  let created = false;
  await assert.rejects(
    openUartGdbBridge({
      ...options,
      signal: AbortSignal.abort(),
      createSerial: () => {
        created = true;
        return new FakeUart();
      },
    }),
    /operationCancelled/,
  );
  assert.equal(created, false);
});

test('UART GDB uses its matching S3 plugin and does not inherit another chip configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-uart-gdb-config-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-uart-gdb-config-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const binary = path.join(root, 'bin', 'xtensa-esp-elf-gdb-no-python.exe');
  const environment = { XTENSA_GNU_CONFIG: 'wrong-chip.so', KEEP: 'yes' };
  await assert.rejects(esp32UartGdbEnvironment(binary, environment), /debuggerUartGdbConfig/);
  await fs.mkdir(path.join(root, 'lib'));
  const plugin = path.join(root, 'lib', 'xtensa_esp32s3.so');
  await fs.writeFile(plugin, 'fixture');
  assert.deepEqual(await esp32UartGdbEnvironment(binary, environment), {
    XTENSA_GNU_CONFIG: plugin,
    KEEP: 'yes',
  });
  assert.equal(environment.XTENSA_GNU_CONFIG, 'wrong-chip.so');
  assert.deepEqual(
    await esp32UartGdbEnvironment(
      path.join(root, 'legacy', 'bin', 'xtensa-esp32s3-elf-gdb.exe'),
      environment,
    ),
    { KEEP: 'yes' },
  );
});

test('UART open errors preserve their cause and leave no connection or reset writes', async () => {
  for (const synchronous of [false, true]) {
    const serial = new FakeUart();
    serial.open = (callback) => {
      if (synchronous) throw new Error('Access denied');
      callback(new Error('Access denied'));
    };
    await assert.rejects(openUartGdbBridge({ ...options, createSerial: () => serial }), /Access denied/);
    assert.equal(serial.isOpen, false);
    assert.equal(serial.destroyed, true);
    assert.equal(serial.writes.length, 0);
  }
});

test('runtime handshake splits stop packets and preserves binary traffic in both directions', async (t) => {
  const serial = new FakeUart();
  const initial = rsp('T05thread:1;');
  serial.onWrite = (bytes) => {
    if (bytes.equals(Buffer.from([3]))) {
      serial.receive(Buffer.concat([Buffer.from('boot log\r\n'), initial.subarray(0, 5)]));
      setImmediate(() => serial.receive(initial.subarray(5)));
    }
  };
  const bridge = await openUartGdbBridge({ ...options, createSerial: () => serial });
  t.after(() => bridge.close());
  const client = await connect(bridge.port);
  t.after(() => client.destroy());
  const received: Buffer[] = [];
  client.on('data', (bytes) => received.push(bytes));
  await until(() => Buffer.concat(received).length >= initial.length);
  assert.deepEqual(Buffer.concat(received), initial);
  const binary = Buffer.from([0, 255, 128, 36, 35, 125, 3]);
  const writes = serial.writes.length;
  client.write(binary);
  await until(() => serial.writes.length > writes);
  assert.deepEqual(serial.writes.at(-1), binary);
  serial.receive(binary);
  await until(() => Buffer.concat(received).length === initial.length + binary.length);
  assert.deepEqual(Buffer.concat(received).subarray(initial.length), binary);
  await bridge.close();
  assert.equal(serial.isOpen, false);
  assert.equal(serial.closeCount, 1);
  assert.equal(serial.destroyed, true);
});

test('panic attach queries a previously emitted stop without an interrupt byte', async (t) => {
  const serial = new FakeUart();
  serial.onWrite = (bytes) => {
    if (bytes.equals(rsp('?'))) serial.receive(rsp('S0b'));
  };
  const bridge = await openUartGdbBridge({ ...options, stubMode: 'panic', createSerial: () => serial });
  t.after(() => bridge.close());
  assert.deepEqual(serial.writes, [rsp('?')]);
});

test('runtime attach queries an already-paused stub once when it ignores the interrupt byte', async (t) => {
  const serial = new FakeUart();
  serial.onWrite = (bytes) => {
    if (bytes.equals(rsp('?'))) serial.receive(rsp('T02'));
  };
  const bridge = await openUartGdbBridge({ ...options, createSerial: () => serial });
  t.after(() => bridge.close());
  assert.deepEqual(serial.writes, [Buffer.from([3]), rsp('?')]);
});

test('runtime fallback query cannot run after a successful handshake or cancellation', async (t) => {
  const ready = new FakeUart();
  ready.onWrite = (bytes) => {
    if (bytes.equals(Buffer.from([3]))) ready.receive(rsp('T02'));
  };
  const bridge = await openUartGdbBridge({ ...options, createSerial: () => ready });
  t.after(() => bridge.close());
  const cancelled = new FakeUart();
  const abort = new AbortController();
  const pending = openUartGdbBridge({ ...options, signal: abort.signal, createSerial: () => cancelled });
  const rejected = assert.rejects(pending, /operationCancelled/);
  await until(() => cancelled.writes.length === 1);
  abort.abort();
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(ready.writes, [Buffer.from([3])]);
  assert.deepEqual(cancelled.writes, [Buffer.from([3])]);
  assert.equal(cancelled.isOpen, false);
});

test('ordinary firmware and invalid stop checksums timeout and release the port', async () => {
  const serial = new FakeUart();
  serial.onWrite = () => serial.receive('hello $S05#00');
  await assert.rejects(
    openUartGdbBridge({ ...options, timeoutMs: 30, createSerial: () => serial }),
    /debuggerUartStubTimeout/,
  );
  assert.equal(serial.isOpen, false);
  assert.equal(serial.closeCount, 1);
});

test('cancellation during a delayed open waits for actual close, leaving no late serial handle', async () => {
  const serial = new FakeUart();
  serial.openDelay = 25;
  serial.closeDelay = 10;
  const abort = new AbortController();
  const pending = openUartGdbBridge({ ...options, signal: abort.signal, createSerial: () => serial });
  const rejected = assert.rejects(pending, /operationCancelled/);
  abort.abort();
  await rejected;
  assert.equal(serial.isOpen, false);
  assert.equal(serial.closeCount, 1);
  assert.equal(serial.writes.length, 0);
});

test('one GDB client owns the bridge and the second cannot inject serial commands', async (t) => {
  const serial = new FakeUart();
  serial.onWrite = (bytes) => {
    if (bytes[0] === 3) serial.receive(rsp('S05'));
  };
  const bridge = await openUartGdbBridge({ ...options, createSerial: () => serial });
  t.after(() => bridge.close());
  const first = await connect(bridge.port);
  first.resume();
  t.after(() => first.destroy());
  const second = await connect(bridge.port);
  const closed = new Promise<void>((resolve) => second.once('close', () => resolve()));
  second.write('unauthorized');
  second.on('error', () => {});
  await closed;
  assert.equal(Buffer.concat(serial.writes).includes(Buffer.from('unauthorized')), false);
  assert.equal(first.destroyed, false);
});

test('serial failure and excessive pre-client data tear down the local listener', async () => {
  for (const overflow of [false, true]) {
    const serial = new FakeUart();
    serial.onWrite = (bytes) => {
      if (bytes[0] === 3) serial.receive(rsp('S05'));
    };
    let failure: Error | undefined;
    const bridge = await openUartGdbBridge({
      ...options,
      createSerial: () => serial,
      onError: (error) => {
        failure = error;
      },
    });
    if (overflow) serial.receive(Buffer.alloc(1024 * 1024 + 1));
    else serial.emit('error', new Error('USB unplugged'));
    await until(() => !serial.isOpen);
    assert.match(failure?.message ?? '', overflow ? /debuggerUartOverflow/ : /USB unplugged/);
    const socket = net.connect(bridge.port, '127.0.0.1');
    await assert.rejects(once(socket, 'connect'));
    socket.destroy();
    await bridge.close();
  }
});
