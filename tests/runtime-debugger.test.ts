import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeDebugger } from '../src/core/runtime-debugger';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { createCore } from '../src/core/service';
import { getBoardAdapter } from '../extensions/registry';
import type { RuntimePlugins } from '../src/core/runtime-plugins';
import type { RuntimePluginInfo, RuntimePluginManifest } from '../src/shared/plugins';
import type { DebuggerState, ProjectConfig } from '../src/shared/contracts';

const stopped = (): DebuggerState => ({
  connection: 'stopped',
  tools: { gdb: true, server: true },
  message: '',
  symbols: '',
  registers: [{ name: 'pc', value: '0x08000008' }],
  stack: [],
  breakpoints: [],
  log: [],
  programCounter: '0x08000008',
});

async function fixture(t: TestContext, mode: RuntimePluginManifest['debugger']['mode']) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-runtime-debugger-'));
  const marker = path.join(root, '.uel');
  const base = getBoardAdapter('STM32F103C8T6').createConfig();
  let config: ProjectConfig = {
    ...base,
    boardId: 'Debug_Fixture',
    programmer: { ...base.programmer!, serialNumber: 'AABBCCDD' },
  };
  const calls: { id: string; method: string; args: unknown[] }[] = [];
  const checks: { id: string; passive: boolean }[] = [];
  const nativeConfigs: ProjectConfig[] = [];
  let nativeDisconnects = 0;
  let result: unknown = stopped();
  const plugin: RuntimePluginInfo = {
    id: 'Debug_Fixture',
    name: 'Fixture debugger',
    directory: root,
    fingerprint: 'a'.repeat(64),
    trust: 'required',
    manifest: {
      apiVersion: 2,
      runtimeApiVersion: 2,
      kind: 'board',
      id: 'Debug_Fixture',
      name: 'Fixture debugger',
      version: '1.0.0',
      runtime: 'runtime.mjs',
      transport: 'usb',
      capabilities: ['probe', 'debug'],
      support: { chips: ['Fixture'], status: 'experimental' },
      defaultConfig: config,
      compiler: { mode: 'host', baseRuntime: 'STM32F103C8T6' },
      debugger: { mode },
      layout: { recommendedFlashSizes: [65536], ramSize: 20480 },
      constraints: {},
      ui: { fields: [] },
    },
  };
  const trusted = async () => !!(await fs.stat(marker).catch(() => null));
  const manager = {
    async state() {
      return { plugins: [{ ...plugin, trust: (await trusted()) ? 'permanent' : 'required' }], errors: [] };
    },
    async assertTrusted(id: string, passive = false) {
      checks.push({ id, passive });
      if (id !== plugin.id || !(await trusted())) throw Error('error.runtimePluginTrustRequired');
    },
    async invokeDebug(id: string, method: string, args: unknown[]) {
      calls.push({ id, method, args });
      if (!(await trusted())) throw Error('error.runtimePluginTrustRequired');
      if (mode === 'extend' && !['state', 'memory'].includes(method))
        throw Error('error.runtimePluginCapability');
      if (method === 'state') return mode === 'extend' ? { message: 'plugin extension' } : result;
      if (method === 'memory') return '01020304';
      if (method === 'storage') return null;
    },
  } as unknown as RuntimePlugins;
  t.mock.method(
    HardwareDebugger.prototype,
    'connect',
    async function (this: HardwareDebugger, next: ProjectConfig) {
      if (this.active) throw Error('error.debuggerBusy');
      nativeConfigs.push(structuredClone(next));
    },
  );
  t.mock.method(HardwareDebugger.prototype, 'state', async () => stopped());
  t.mock.method(HardwareDebugger.prototype, 'disconnect', async () => {
    nativeDisconnects++;
  });
  const debug = new RuntimeDebugger(
    root,
    root,
    undefined,
    () => manager,
    () => config,
  );
  t.after(async () => {
    // Re-authorize the fixture solely for normal owner cleanup; revocation itself is tested below.
    await fs.writeFile(marker, 'fixture');
    await debug.disconnect();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-runtime-debugger-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    marker,
    config,
    debug,
    calls,
    checks,
    nativeConfigs,
    plugin,
    setConfig: (next: ProjectConfig) => {
      config = next;
    },
    setResult: (next: unknown) => {
      result = next;
    },
    disconnects: () => nativeDisconnects,
    authorize: () => fs.writeFile(marker, 'fixture'),
  };
}

test('approved builtin debug fallback maps the target and does not block itself with its own hardware ownership', async (t) => {
  const context = await fixture(t, 'builtin');
  await assert.rejects(context.debug.connect(context.config), /runtimePluginTrustRequired/);
  assert.equal(
    context.nativeConfigs.length,
    0,
    'unapproved metadata must not execute a native fallback tool',
  );
  assert.equal(context.debug.active, false);
  await context.authorize();
  await context.debug.connect(context.config);
  assert.equal(context.nativeConfigs.length, 1);
  assert.equal(context.nativeConfigs[0].boardId, 'STM32F103C8T6');
  assert.equal(context.nativeConfigs[0].programmer?.serialNumber, 'AABBCCDD');
  assert.equal(context.debug.active, true);
  await assert.rejects(context.debug.connect(context.config), /debuggerBusy/);
  const core = await createCore({
    projectRoot: '',
    dataRoot: path.join(context.root, 'core-data'),
    onEvent() {},
    refreshDevices: false,
    createRuntimes: () => [],
    hardwareBusy: () => context.debug.active,
  });
  t.after(() => core.shutdown());
  let entered = false;
  await assert.rejects(
    core.runHardwareAction(async () => {
      entered = true;
    }),
    /debuggerOwnsDevice/,
  );
  assert.equal(entered, false);
  await context.debug.disconnect();
  assert.equal(context.debug.active, false);
  await core.runHardwareAction(async () => {
    entered = true;
  });
  assert.equal(entered, true);
  assert.ok(context.disconnects() > 0);
});

test('extend providers merge native state and keep state checks passive while executing actions through full trust', async (t) => {
  const context = await fixture(t, 'extend');
  await context.authorize();
  await context.debug.connect(context.config);
  assert.equal(context.nativeConfigs.length, 1, 'missing custom connect falls back to the declared builtin');
  const state = await context.debug.state();
  assert.equal(state.message, 'plugin extension');
  assert.equal(state.registers[0].name, 'pc');
  assert.equal(context.checks.at(-1)?.passive, true, 'read-only sampling must use cached package checks');
  assert.equal(await context.debug.memory(0x20000000, 4), '01020304');
  assert.equal(context.checks.at(-1)?.passive, false);
  await context.debug.disconnect();
  assert.equal(context.debug.active, false);
});

test('replacement providers retain the connected owner across main target changes and reject invalid state or revoked consent', async (t) => {
  const context = await fixture(t, 'replace');
  await context.authorize();
  await context.debug.connect(context.config);
  assert.equal(context.nativeConfigs.length, 0);
  context.setConfig(getBoardAdapter('Esp32_S3_CAM').createConfig());
  await context.debug.action('step');
  assert.equal(
    context.calls.at(-1)?.id,
    context.plugin.id,
    'connected provider is pinned independently of the main selection',
  );
  assert.equal(context.calls.at(-1)?.method, 'action');
  context.setResult({ ...stopped(), connection: 'unrecognized' });
  await assert.rejects(context.debug.state(), /runtimePluginResult/);
  context.setResult(stopped());
  const before = context.calls.length;
  await assert.rejects(context.debug.memory(-1, 1), /invalidParams/);
  await assert.rejects(context.debug.memory(0x20000000, 4097), /invalidParams/);
  assert.equal(context.calls.length, before);
  await fs.unlink(context.marker);
  await assert.rejects(context.debug.action('continue'), /runtimePluginTrustRequired/);
  assert.equal(context.debug.active, true, 'revoked execution does not silently relinquish a live owner');
  assert.equal((await context.debug.state()).message, 'error.runtimePluginTrustRequired');
  await context.authorize();
  await context.debug.disconnect();
  assert.equal(context.debug.active, false);
});
