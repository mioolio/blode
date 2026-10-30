import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCore } from '../src/core/service';
import { SerialConnection } from '../src/core/serial';
import { getBoardAdapter } from '../extensions/registry';
import { createWebDebugger } from '../src/core/web-debugger';
import type { HardwareDebugger } from '../src/core/hardware-debugger';
import { createHostServices } from '../src/core/host-services';
import type { RuntimeDebugger } from '../src/core/runtime-debugger';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-debug-handoff-'));
  let owner: string | undefined;
  let active = false;
  const events: string[] = [];
  t.mock.method(SerialConnection, 'list', async () => [{ path: 'COM3' }, { path: 'COM4' }]);
  t.mock.method(SerialConnection.prototype, 'open', async (port: string) => {
    events.push('monitor.open:' + port);
  });
  t.mock.method(SerialConnection.prototype, 'close', async () => {
    events.push('monitor.close');
  });
  const core = await createCore({
    projectRoot: '',
    dataRoot: root,
    onEvent() {},
    createRuntimes: () => [],
    refreshDevices: false,
    hardwareBusy: () => active,
    debuggerSerialPort: () => owner,
  });
  t.after(async () => {
    await core.shutdown();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^blode-debug-handoff-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  config.debugger = { transport: 'uart-gdb', port: 'COM3', baudRate: 115200, stubMode: 'runtime' };
  return {
    core,
    config,
    events,
    setOwner: (port?: string) => {
      owner = port;
    },
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

test('UART debugger atomically closes the monitor before attaching, then reserves only its own serial port', async (t) => {
  const f = await fixture(t);
  await f.core.serialOpen('COM3', 115200);
  f.events.length = 0;
  await f.core.runDebuggerConnect(f.config, async () => {
    f.events.push('debugger.attach');
    await assert.rejects(f.core.serialOpen('COM3'), /error.busy/);
    f.setOwner('COM3');
    f.setActive(true);
  });
  assert.deepEqual(f.events, ['monitor.close', 'debugger.attach']);
  await assert.rejects(f.core.serialOpen('COM3'), /debuggerOwnsDevice/);
  if (process.platform === 'win32') await assert.rejects(f.core.serialOpen('com3'), /debuggerOwnsDevice/);
  await f.core.serialOpen('COM4');
  assert.equal(f.events.at(-1), 'monitor.open:COM4');
  f.setActive(false);
  await assert.rejects(
    f.core.serialOpen('COM3'),
    /debuggerOwnsDevice/,
    'cleanup keeps ownership even after GDB exits',
  );
  f.setOwner(undefined);
  await f.core.serialOpen('COM3');
  assert.equal(f.events.at(-1), 'monitor.open:COM3');
});

test('invalid UART selection and an existing debugger cannot close the monitor or attach; failed attaches release the operation lock', async (t) => {
  const f = await fixture(t);
  let attaches = 0;
  const attach = async () => {
    attaches++;
  };
  await assert.rejects(
    f.core.runDebuggerConnect({ ...f.config, debugger: { ...f.config.debugger, port: 'COM99' } }, attach),
    /portUnavailable/,
  );
  assert.deepEqual(f.events, []);
  f.setActive(true);
  await assert.rejects(f.core.runDebuggerConnect(f.config, attach), /debuggerOwnsDevice/);
  assert.deepEqual(f.events, []);
  f.setActive(false);
  await assert.rejects(
    f.core.runDebuggerConnect(f.config, async () => {
      throw Error('fixture-stub-timeout');
    }),
    /fixture-stub-timeout/,
  );
  await f.core.serialOpen('COM3');
  assert.equal(attaches, 0);
  assert.equal(f.events.at(-1), 'monitor.open:COM3');
});

test('USB-JTAG does not close a working serial monitor, while Web UART requests use the same atomic handoff', async (t) => {
  const f = await fixture(t);
  await f.core.runDebuggerConnect({ ...f.config, debugger: { transport: 'usb-jtag' } }, async () => {
    f.events.push('usb.attach');
  });
  assert.deepEqual(f.events, ['usb.attach']);
  const debuggerService = {
    connect: async () => {
      f.events.push('uart.attach');
    },
  } as unknown as HardwareDebugger;
  const web = createWebDebugger(debuggerService, f.core);
  await web.invoke('debuggerConnect', [f.config]);
  assert.deepEqual(f.events, ['usb.attach', 'monitor.close', 'uart.attach']);
  await assert.rejects(
    web.invoke('debuggerConnect', [{ ...f.config, debugger: { transport: 'uart-gdb', port: 'COM99' } }]),
    /portUnavailable/,
  );
  assert.deepEqual(f.events, ['usb.attach', 'monitor.close', 'uart.attach']);
});

test('plugin debugger connection routes share the serial handoff and reject a stale runtime before closing the monitor', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.core, 'currentConfig', () => f.config);
  const services = createHostServices({
    core: f.core,
    collaboration: {} as any,
    firmware: {} as any,
    recent: {} as any,
    dataRoot: os.tmpdir(),
    toolchainRoot: os.tmpdir(),
    emit() {},
    runtimeDebugger: () =>
      ({
        invokePlugin: async (id: string) => {
          f.events.push('plugin.attach:' + id);
          return 'attached';
        },
      }) as unknown as RuntimeDebugger,
  });
  t.after(() => services.close());
  await assert.rejects(
    services.invoke('runtimePluginDebug', ['Other_Runtime', 'connect', []]),
    /runtimePluginConfig/,
  );
  assert.deepEqual(f.events, []);
  assert.equal(await services.invoke('runtimePluginDebug', ['Esp32_S3_CAM', 'connect', []]), 'attached');
  assert.deepEqual(f.events, ['monitor.close', 'plugin.attach:Esp32_S3_CAM']);
});

test('plugin disconnect cancels a pending UART connect through either RPC form while other actions stay locked', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.core, 'currentConfig', () => f.config);
  let cancelConnect: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const services = createHostServices({
    core: f.core,
    collaboration: {} as any,
    firmware: {} as any,
    recent: {} as any,
    dataRoot: os.tmpdir(),
    toolchainRoot: os.tmpdir(),
    emit() {},
    runtimeDebugger: () =>
      ({
        invokePlugin: async (id: string, method: string, args: unknown[]) => {
          assert.equal(id, 'Esp32_S3_CAM');
          if (method === 'connect') {
            await new Promise<void>((_resolve, reject) => {
              cancelConnect = () => reject(new Error('error.operationCancelled'));
              signalStarted?.();
            });
          } else if (method === 'disconnect' || (method === 'action' && args[0] === 'disconnect')) {
            cancelConnect?.();
          } else {
            throw new Error('unexpected fixture action');
          }
        },
      }) as unknown as RuntimeDebugger,
  });
  t.after(async () => {
    cancelConnect?.();
    await services.close();
  });
  for (const [method, args] of [
    ['disconnect', []],
    ['action', ['disconnect']],
  ] as const) {
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const connecting = assert.rejects(
      services.invoke('runtimePluginDebug', ['Esp32_S3_CAM', 'connect', []]),
      /operationCancelled/,
    );
    await started;
    await assert.rejects(
      services.invoke('runtimePluginDebug', ['Esp32_S3_CAM', 'action', ['continue']]),
      /error.busy/,
    );
    await services.invoke('runtimePluginDebug', ['Esp32_S3_CAM', method, args]);
    await connecting;
    await f.core.serialOpen('COM3');
    assert.equal(f.events.at(-1), 'monitor.open:COM3');
  }
});
