import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCore, type CoreOptions } from '../src/core/service';
import { SerialConnection } from '../src/core/serial';
import { Drivers } from '../src/core/drivers';
import type { PlatformRuntime } from '../extensions/runtime';
import type { LogEvent, ToolchainStatus } from '../src/shared/contracts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const readyToolchain: ToolchainStatus = {
  arduinoCli: false,
  esp32Core: false,
  python: false,
  esptool: false,
  stlink: true,
  versions: { stlink: 'test' },
};

async function fixture(t: TestContext, overrides: Partial<CoreOptions> = {}) {
  let discoveries = 0;
  let statusReads = 0;
  const events: LogEvent[] = [];
  const runtime: PlatformRuntime = {
    id: 'STM32F103C8T6',
    transport: 'stlink',
    sourceInputs: [],
    status: async () => {
      statusReads++;
      return structuredClone(readyToolchain);
    },
    discover: async () => {
      discoveries++;
      return [
        {
          id: 'stlink:test',
          platformId: 'STM32F103C8T6',
          transport: 'stlink',
          name: 'Test probe',
          serialNumber: 'test',
          debugProbe: { serialNumber: 'test', name: 'Test probe' },
        },
      ];
    },
    invalidate() {},
    install: async () => {
      throw new Error('installation must not run');
    },
    build: async () => {
      throw new Error('compilation must not run');
    },
    flash: async () => {
      throw new Error('flashing must not run');
    },
    probe: async () => {
      throw new Error('identification must not run');
    },
  };
  t.mock.method(SerialConnection, 'list', async () => [{ path: 'COM7' }]);
  const core = await createCore({
    projectRoot: '',
    dataRoot: path.join(tmpdir(), 'blode-startup-mocked'),
    refreshDevices: true,
    progressiveStartup: true,
    createRuntimes: () => [runtime],
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  t.after(() => core.shutdown());
  return { core, runtime, events, counts: () => ({ discoveries, statusReads }) };
}

test('progressive startup returns the welcome state before PnP completes and initializes only once', async (t) => {
  const pnp = deferred<void>();
  const statusStarted = deferred<void>();
  const toolchain = deferred<void>();
  const initialized = deferred<void>();
  let driverReads = 0;
  let complete = false;
  t.mock.method(Drivers.prototype, 'statuses', async () => {
    driverReads++;
    await pnp.promise;
    return [];
  });
  t.after(() => {
    pnp.resolve();
    toolchain.resolve();
  });
  const { core, runtime, events, counts } = await fixture(t, {
    onEvent: (event) => {
      events.push(event);
      if (complete && event.message === 'status.devicesChanged') initialized.resolve();
    },
  });
  t.mock.method(runtime, 'status', async () => {
    statusStarted.resolve();
    await toolchain.promise;
    return structuredClone(readyToolchain);
  });
  let returned = false;
  const response = core.getState().then((state) => {
    returned = true;
    return state;
  });
  await setImmediate();
  assert.equal(returned, true, 'the initial UI must not wait for the PnP helper');
  const initial = await response;
  assert.equal(initial.initializing, true);
  assert.equal(initial.workspaceOpen, false);
  assert.equal(initial.connections?.probes.state, 'unknown');
  assert.deepEqual(initial.drivers, []);
  assert.equal(counts().discoveries, 0);
  assert.equal((await core.getState()).initializing, true);
  assert.equal(driverReads, 1, 'concurrent UI snapshots must share initialization');
  pnp.resolve();
  await statusStarted.promise;
  assert.equal((await core.getState()).initializing, true, 'tools are still being checked');
  complete = true;
  toolchain.resolve();
  await initialized.promise;
  const ready = await core.getState();
  assert.equal(ready.initializing, false);
  assert.equal(ready.connections?.probes.state, 'ready');
  assert.equal(ready.debugProbes[0]?.serialNumber, 'test');
  assert.equal(ready.toolchain.stlink, true);
  await Promise.all([core.getState(), core.getState()]);
  assert.equal(counts().discoveries, 1, 'ordinary snapshots must not rescan hardware');
  await core.scanDevices();
  assert.equal(counts().discoveries, 2, 'explicit refresh must still work');
});

test('progressive startup does not publish late events or start tool checks after shutdown', async (t) => {
  t.mock.method(Drivers.prototype, 'statuses', async () => []);
  const discovery = deferred<void>();
  const discoveryStarted = deferred<void>();
  t.after(() => discovery.resolve());
  const { core, runtime, events, counts } = await fixture(t);
  t.mock.method(runtime, 'discover', async () => {
    discoveryStarted.resolve();
    await discovery.promise;
    return [];
  });
  await core.getState();
  await discoveryStarted.promise;
  const before = events.length;
  await core.shutdown();
  discovery.resolve();
  await setImmediate();
  assert.equal(events.length, before);
  assert.equal(counts().statusReads, 0);
});

test('nonprogressive hosts retain the complete initial snapshot contract', async (t) => {
  const pnp = deferred<void>();
  t.mock.method(Drivers.prototype, 'statuses', async () => {
    await pnp.promise;
    return [];
  });
  t.after(() => pnp.resolve());
  const { core } = await fixture(t, { progressiveStartup: false });
  let returned = false;
  const response = core.getState().then((state) => {
    returned = true;
    return state;
  });
  await setImmediate();
  assert.equal(returned, false);
  pnp.resolve();
  const ready = await response;
  assert.equal(ready.initializing, false);
  assert.equal(ready.connections?.probes.state, 'ready');
  assert.equal(ready.debugProbes[0]?.serialNumber, 'test');
  assert.equal(ready.toolchain.stlink, true);
});

test('a failed initial scan reports its error once and remains manually refreshable', async (t) => {
  let reads = 0;
  t.mock.method(Drivers.prototype, 'statuses', async () => {
    if (++reads === 1) throw new Error('PnP helper unavailable');
    return [];
  });
  const initialized = deferred<void>();
  const { core, events, counts } = await fixture(t, {
    onEvent: (event) => {
      events.push(event);
      if (event.message === 'status.devicesChanged') initialized.resolve();
    },
  });
  await core.getState();
  await initialized.promise;
  const failed = await core.getState();
  assert.equal(failed.initializing, false);
  assert.equal(failed.connections?.probes.state, 'unavailable');
  assert.equal(events.filter((event) => event.message === 'PnP helper unavailable').length, 1);
  assert.equal(counts().discoveries, 0);
  await core.getState();
  assert.equal(counts().discoveries, 0);
  await core.scanDevices();
  assert.equal(counts().discoveries, 1);
});
