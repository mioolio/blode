import test from 'node:test';
import assert from 'node:assert/strict';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { RuntimeDebugger } from '../src/core/runtime-debugger';
import { getBoardAdapter } from '../extensions/registry';
import type { RuntimePlugins } from '../src/core/runtime-plugins';

test('identical simultaneous STM32 selections preserve the pending configuration and finish without retries', async (t) => {
  let queries = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = {
    state: async () => {
      queries++;
      await gate;
      return { plugins: [], errors: [] };
    },
  } as unknown as RuntimePlugins;
  const debug = new RuntimeDebugger(
    '.',
    '.',
    undefined,
    () => manager,
    () => undefined,
  );
  let tools = 0;
  t.mock.method(debug as any, 'tools', async () => {
    tools++;
    return { gdb: 'gdb', server: 'st-util', scripts: null };
  });
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  const first = debug.state(config);
  const second = debug.state(structuredClone(config));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(queries, 2);
  assert.equal(tools, 2);
  assert.ok(results.every((value) => value.tools.gdb && value.tools.server));
});

test('status polling never waits on a slow automatic ELF resolver; explicit storage refresh still resolves it', async (t) => {
  let reads = 0;
  const debug = new HardwareDebugger('.', '.', undefined, async () => {
    reads++;
    return null;
  });
  t.mock.method(debug as any, 'tools', async () => ({ gdb: 'gdb', server: 'st-util', scripts: null }));
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  for (let i = 0; i < 8; i++) assert.equal((await debug.state(structuredClone(config))).tools.gdb, true);
  assert.equal(reads, 0);
  assert.equal(await debug.storage(), null);
  assert.equal(reads, 1);
});
