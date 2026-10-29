import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimePlugins } from '../src/core/runtime-plugins';
import { parseRuntimePluginManifest } from '../src/core/runtime-plugin-schema';
import { getBoardAdapter, listBoards } from '../extensions/registry';
import { safeWorkspacePath } from '../src/core/workspace';
import type { RuntimeHost, PlatformRuntime } from '../extensions/runtime';
import type { RuntimePluginManifest } from '../src/shared/plugins';
import type { ProjectConfig } from '../src/shared/contracts';

async function fixture(t: TestContext, customize?: (manifest: RuntimePluginManifest) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-runtime-plugins-'));
  const id = 'Fixture_' + randomUUID().replaceAll('-', '');
  const directory = path.join(root, 'plugins', id);
  const project = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  await fs.mkdir(path.join(directory, 'tools'), { recursive: true });
  await fs.mkdir(project);
  const config = {
    ...getBoardAdapter('STM32F103C8T6').createConfig(),
    boardId: id,
    programmer: { transport: 'usb' as const, serialNumber: '', frequencyKhz: 1800 },
    runtime: { deviceId: 'physical-usb-1', values: { channel: 'A', enabled: true, speed: 10 } },
  };
  const manifest: RuntimePluginManifest = {
    apiVersion: 2,
    runtimeApiVersion: 2,
    kind: 'board',
    id,
    name: 'Fixture USB runtime',
    version: '1.0.0',
    runtime: 'runtime.mjs',
    transport: 'usb',
    capabilities: ['compile', 'flash', 'probe', 'layout'],
    support: { chips: ['Fixture MCU'], status: 'experimental' },
    defaultConfig: config,
    compiler: {
      mode: 'plugin',
      baseRuntime: 'STM32F103C8T6',
      defaultTool: {
        id: 'FixtureCompiler',
        executable: 'tools/compiler.mjs',
        runner: 'node',
        args: ['--default'],
      },
    },
    debugger: { mode: 'replace', view: 'debugger.html' },
    layout: {
      flashBaseAddress: 0x08000000,
      recommendedFlashSizes: [65536],
      possibleFlashSizes: [65536, 131072],
      ramSize: 20480,
    },
    constraints: { chipIds: ['0x410'] },
    ui: {
      actions: [{ id: 'identify', label: 'Identify', confirm: true }],
      fields: [
        {
          id: 'channel',
          label: 'Channel',
          type: 'select',
          options: [{ value: 'A', label: 'A' }],
          default: 'A',
        },
        { id: 'enabled', label: 'Enabled', type: 'boolean', default: true },
        { id: 'speed', label: 'Speed', type: 'number', min: 1, max: 100 },
      ],
      view: 'device.html',
    },
  };
  customize?.(manifest);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const marker = 'plugin_' + id;
  await fs.writeFile(
    path.join(directory, 'runtime.mjs'),
    `
import fs from 'node:fs/promises';
globalThis[${JSON.stringify(marker)}] = (globalThis[${JSON.stringify(marker)}] ?? 0) + 1;
export function createRuntime(host, manifest) {
 return {id:manifest.id,transport:manifest.transport,sourceInputs:[],invalidate(){},
  async status(){return {arduinoCli:false,esp32Core:false,python:false,esptool:false,versions:{fixture:'1.0.0'}}},
  async install(){return this.status()},
  async discover(){return [{id:manifest.id+':usb:1',platformId:manifest.id,transport:'usb',deviceId:'physical-usb-1',name:'USB fixture'}]},
  async probe(config){return {output:'probe fixture',config}},
  async build(config,inputs){
   const outputDirectory=await host.resetDirectory('.blode/build');
   await fs.writeFile(outputDirectory+'/plugin.bin',Buffer.alloc(8));
   const command=await host.runDefaultTool(['--fixture']);
   return {success:true,flashUsed:8,ramUsed:0,flashTotal:config.flashSize,ramTotal:20480,artifacts:['.blode/build/plugin.bin'],timestamp:new Date().toISOString(),output:'target='+config.boardId+';'+command.output};
  },
  async flash(){},async flashPrepared(){},
  debugger:{async state(){return {source:manifest.id}}, async action(action){return action}},
  device:{async identify(value){return {device:manifest.id,value}}},
 };
}
`,
  );
  await fs.writeFile(path.join(directory, 'tools/compiler.mjs'), 'console.log("fixture compiler");');
  await fs.writeFile(path.join(directory, 'debugger.html'), '<main>Debugger fixture</main>');
  await fs.writeFile(path.join(directory, 'device.html'), '<main>Device fixture</main>');
  const commands: { command: string; args: string[] }[] = [];
  const host: RuntimeHost = {
    dataRoot,
    signal: new AbortController().signal,
    projectRoot: () => project,
    readProjectFiles: async () => [],
    emit() {},
    listPorts: async () => [],
    requirePort: async () => {
      throw Error('must not access hardware');
    },
    closeSerial: async () => {},
    resolveWorkspacePath: (relative, options) => safeWorkspacePath(project, relative, options),
    async resetDirectory(relative) {
      assert.equal(relative, '.blode/build');
      const directory = await safeWorkspacePath(project, relative, { internal: true });
      await fs.mkdir(directory, { recursive: true });
      return directory;
    },
    async runCommand(command, args) {
      commands.push({ command, args });
      return { code: 0, output: 'default tool called' };
    },
  };
  const managers: RuntimePlugins[] = [];
  const makeManager = (
    customDataRoot = dataRoot,
    openView?: ConstructorParameters<typeof RuntimePlugins>[0]['openView'],
  ) => {
    const manager = new RuntimePlugins({
      roots: [path.join(root, 'plugins')],
      dataRoot: customDataRoot,
      openView,
    });
    managers.push(manager);
    return manager;
  };
  const manager = makeManager();
  t.after(async () => {
    await Promise.all(managers.map((manager) => manager.close()));
    delete (globalThis as any)[marker];
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-runtime-plugins-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    id,
    directory,
    project,
    dataRoot,
    config,
    manifest,
    host,
    commands,
    manager,
    makeManager,
    marker,
  };
}

async function authorize(manager: RuntimePlugins, id: string, permanent = false) {
  const state = await manager.state();
  const plugin = state.plugins.find((plugin) => plugin.id === id)!;
  await manager.trust({ id, fingerprint: plugin.fingerprint, confirm: true, permanent });
}

test('declared view paths, ids, sizes and locations stay within the package schema', async (t) => {
  const context = await fixture(t);
  const valid = {
    id: 'inspect',
    label: 'Inspect',
    file: 'device.html',
    location: 'window' as const,
    width: 900,
    height: 600,
  };
  const manifest = (views: unknown[]) => ({ ...context.manifest, ui: { ...context.manifest.ui, views } });
  assert.equal(parseRuntimePluginManifest(manifest([valid])).ui.views?.[0].id, 'inspect');
  for (const value of [
    { ...valid, file: '../outside.html' },
    { ...valid, file: 'C:/outside.html' },
    { ...valid, file: 'nested\\outside.html' },
    { ...valid, file: 'https://example.invalid/ui.html' },
    { ...valid, id: '../inspect' },
    { ...valid, width: 10 },
    { ...valid, location: 'iframe' },
  ])
    assert.throws(() => parseRuntimePluginManifest(manifest([value])), /Manifest/);
  assert.throws(() => parseRuntimePluginManifest(manifest([valid, valid])), /Manifest/);
});

test('business SDK can request only its own declared approved view and passes immutable metadata', async (t) => {
  const context = await fixture(t, (manifest) => {
    manifest.ui.views = [{ id: 'inspect', label: 'Inspect', file: 'device.html', location: 'panel' }];
    manifest.ui.actions!.push({ id: 'openSurface', label: 'Open surface' });
  });
  const runtime = path.join(context.directory, 'runtime.mjs');
  await fs.writeFile(
    runtime,
    (await fs.readFile(runtime, 'utf8')).replace(
      'device:{async identify',
      'device:{async openSurface(viewId){await host.openView(viewId);return true;},async identify',
    ),
  );
  const opened: { id: string; viewId: string; location: string }[] = [];
  const manager = context.makeManager(context.dataRoot, async (id, declaration) => {
    opened.push({ id, viewId: declaration.id, location: declaration.location });
    declaration.label = 'Changed by callback';
  });
  await manager.discover();
  manager.attach(context.host, []);
  await assert.rejects(() => manager.invokeDevice(context.id, 'openSurface', ['inspect']), /TrustRequired/);
  assert.equal(opened.length, 0);
  await authorize(manager, context.id);
  assert.equal(await manager.invokeDevice(context.id, 'openSurface', ['inspect']), true);
  assert.deepEqual(opened, [{ id: context.id, viewId: 'inspect', location: 'panel' }]);
  assert.equal((await manager.state()).plugins[0].manifest.ui.views?.[0].label, 'Inspect');
  for (const id of ['missing', '../inspect', 'another/inspect'])
    await assert.rejects(() => manager.invokeDevice(context.id, 'openSurface', [id]), /Capability/);
  assert.equal(opened.length, 1);
  await fs.writeFile(path.join(context.directory, 'device.html'), '<main>Changed after approval</main>');
  await assert.rejects(
    () => manager.invokeDevice(context.id, 'openSurface', ['inspect']),
    /RestartRequired|TrustRequired/,
  );
  assert.equal(opened.length, 1);
});

test('declarative discovery registers USB capabilities without importing code; explicit trust runs package code and default tool', async (t) => {
  const context = await fixture(t);
  const state = await context.manager.discover();
  assert.equal(state.errors.length, 0);
  assert.equal(state.plugins[0].trust, 'required');
  assert.equal((globalThis as any)[context.marker], undefined);
  const [runtime] = context.manager.attach(context.host, []);
  assert.deepEqual(await runtime.discover(context.config), []);
  assert.deepEqual((await runtime.status(context.config)).versions, {});
  await assert.rejects(() => runtime.build(context.config, { entry: '.' }), /TrustRequired/);
  await assert.rejects(() => context.manager.view(context.id, 'device'), /TrustRequired/);
  assert.equal((globalThis as any)[context.marker], undefined);
  await authorize(context.manager, context.id);
  const devices = await runtime.discover(context.config);
  assert.equal(devices[0].deviceId, 'physical-usb-1');
  assert.equal((globalThis as any)[context.marker], 1);
  const build = await runtime.build(context.config, { entry: '.' });
  assert.equal(build.success, true);
  assert.equal(context.commands[0].command, process.execPath);
  assert.deepEqual(context.commands[0].args, [
    path.join(context.directory, 'tools/compiler.mjs'),
    '--default',
    '--fixture',
  ]);
  assert.match((await context.manager.view(context.id, 'device'))!, /Device fixture/);
  assert.deepEqual(await context.manager.invokeDebug(context.id, 'state', []), { source: context.id });
  await assert.rejects(() => context.manager.invokeDebug(context.id, 'constructor', []), /Capability/);
  await assert.rejects(
    () => context.manager.invokeDevice(context.id, 'identify', ['one']),
    /ConfirmRequired/,
  );
  assert.deepEqual(await context.manager.invokeDevice(context.id, 'identify', ['one'], true), {
    device: context.id,
    value: 'one',
  });
  await assert.rejects(() => context.manager.invokeDevice(context.id, 'constructor', [], true), /Capability/);
});

test('permanent trust creates a host-bound .uel; removing it restores the warning immediately', async (t) => {
  const context = await fixture(t);
  await context.manager.discover();
  context.manager.attach(context.host, []);
  await authorize(context.manager, context.id, true);
  assert.equal((await context.manager.state()).plugins[0].trust, 'permanent');
  const marker = JSON.parse(await fs.readFile(path.join(context.directory, '.uel'), 'utf8'));
  assert.equal(marker.suppressWarning, true);
  assert.match(marker.signature, /^[a-f0-9]{64}$/);
  await context.manager.invokeDebug(context.id, 'state', []);
  await fs.unlink(path.join(context.directory, '.uel'));
  assert.equal((await context.manager.state()).plugins[0].trust, 'required');
  await assert.rejects(() => context.manager.invokeDebug(context.id, 'state', []), /TrustRequired/);
});

test('copied or forged .uel cannot authorize code on another host data root', async (t) => {
  const context = await fixture(t);
  await context.manager.discover();
  await authorize(context.manager, context.id, true);
  await context.manager.close();
  const foreign = context.makeManager(path.join(context.root, 'other-host'));
  const state = await foreign.discover();
  assert.equal(state.plugins[0].trust, 'required');
  assert.equal((globalThis as any)[context.marker], undefined);
});

test('code changes revoke existing authorization and stale confirmation fingerprints are rejected', async (t) => {
  const context = await fixture(t);
  const initial = await context.manager.discover();
  const [runtime] = context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  await fs.appendFile(path.join(context.directory, 'runtime.mjs'), '\n// changed business code\n');
  await assert.rejects(() => runtime.build(context.config, { entry: '.' }), /TrustRequired/);
  await assert.rejects(
    () =>
      context.manager.trust({
        id: context.id,
        fingerprint: initial.plugins[0].fingerprint,
        confirm: true,
        permanent: true,
      }),
    /Changed/,
  );
  assert.equal((globalThis as any)[context.marker], undefined);
});

test('malformed packages and path escapes are isolated from valid packages', async (t) => {
  const context = await fixture(t);
  for (const [name, override] of [
    ['Invalid', { apiVersion: 2, kind: 'board' }],
    [
      'Escape',
      {
        ...context.manifest,
        id: 'Escape',
        runtime: '../escape.mjs',
        defaultConfig: { ...context.config, boardId: 'Escape' },
      },
    ],
  ] as const) {
    const directory = path.join(context.root, 'plugins', name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(override));
  }
  const state = await context.manager.discover();
  assert.equal(state.plugins.length, 1);
  assert.equal(state.errors.length, 2);
  assert.equal((globalThis as any)[context.marker], undefined);
});

test('plugin contracts require responsible chips, valid field values and a default compiler component', async (t) => {
  const context = await fixture(t);
  assert.throws(
    () => parseRuntimePluginManifest({ ...context.manifest, support: { chips: [], status: 'supported' } }),
    /Manifest/,
  );
  assert.throws(
    () => parseRuntimePluginManifest({ ...context.manifest, compiler: { mode: 'plugin' } }),
    /Manifest/,
  );
  assert.throws(
    () => parseRuntimePluginManifest({ ...context.manifest, compiler: { mode: 'host' } }),
    /Manifest/,
  );
  await context.manager.discover();
  const adapter = getBoardAdapter(context.id);
  assert.equal(adapter.definition.customFlashSize, true);
  adapter.validateConfig({ ...context.config, flashSize: 200000 });
  assert.throws(
    () => adapter.validateConfig({ ...context.config, runtime: { values: { channel: 'B' } } }),
    /Config/,
  );
  assert.throws(
    () => adapter.validateConfig({ ...context.config, runtime: { values: { speed: 101 } } }),
    /Config/,
  );
  assert.throws(
    () => adapter.validateConfig({ ...context.config, runtime: { values: { enabled: 'true' } } }),
    /Config/,
  );
  await context.manager.close();
  assert.ok(!listBoards().some((board) => board.id === context.id));
});

test('forced compiler components default to the plugin; explicit force switches to the declared host compiler', async (t) => {
  const context = await fixture(t, (manifest) => {
    manifest.compiler.mode = 'host';
    manifest.compiler.forceComponent = true;
  });
  await context.manager.discover();
  let nativeCalls = 0;
  const base = {
    id: 'STM32F103C8T6',
    build: async (config: ProjectConfig) => {
      nativeCalls++;
      assert.equal(config.boardId, 'STM32F103C8T6');
      return {
        success: true,
        flashUsed: 0,
        ramUsed: 0,
        flashTotal: config.flashSize,
        ramTotal: 20480,
        artifacts: [],
        output: 'native host',
        timestamp: new Date().toISOString(),
      };
    },
  } as unknown as PlatformRuntime;
  const [runtime] = context.manager.attach(context.host, [base]);
  await authorize(context.manager, context.id);
  assert.match((await runtime.build(context.config, { entry: '.' })).output, /default tool called/);
  assert.equal(nativeCalls, 0);
  assert.equal(
    (await runtime.build({ ...context.config, runtime: { forceCompiler: true } }, { entry: '.' })).output,
    'native host',
  );
  assert.equal(nativeCalls, 1);
});

test('another plugin compiler requires explicit force, preserves the target, and rejects inconsistent language providers', async (t) => {
  const context = await fixture(t);
  await context.manager.discover();
  context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  const target = getBoardAdapter('STM32F103C8T6').createConfig();
  const defaults = {
    build: async () => {
      throw Error('host build must not run');
    },
  } as unknown as PlatformRuntime;
  const settings = { common: { family: 'plugin' as const, pluginId: context.id } };
  await assert.rejects(
    () => context.manager.build(defaults, target, { entry: '.', settings }),
    /ForceRequired/,
  );
  const result = await context.manager.build(
    defaults,
    { ...target, runtime: { forceCompiler: true } },
    { entry: '.', settings },
  );
  assert.match(result.output, /target=STM32F103C8T6/);
  await assert.rejects(
    () =>
      context.manager.build(
        defaults,
        { ...target, runtime: { forceCompiler: true } },
        {
          settings: {
            platforms: {
              STM32F103C8T6: {
                c: { family: 'plugin', pluginId: context.id },
                cpp: { family: 'plugin', pluginId: 'DifferentPlugin' },
              },
            },
          },
        },
      ),
    /CompilerConflict/,
  );
  await assert.rejects(
    () =>
      context.manager.build(
        defaults,
        { ...target, runtime: { forceCompiler: true } },
        {
          settings: {
            common: { family: 'plugin', pluginId: context.id },
            platforms: { STM32F103C8T6: { cpp: { family: 'gnu-arm' } } },
          },
        },
      ),
    /CompilerConflict/,
  );
});

test('nested .uel files remain business inputs, while root consent markers cannot be executable components', async (t) => {
  const context = await fixture(t);
  await fs.mkdir(path.join(context.directory, 'business'));
  await fs.writeFile(path.join(context.directory, 'business', '.uel'), 'module.exports = 1;');
  await context.manager.discover();
  const [runtime] = context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  await fs.writeFile(path.join(context.directory, 'business', '.uel'), 'module.exports = 2;');
  await assert.rejects(() => runtime.build(context.config, { entry: '.' }), /TrustRequired/);
  await context.manager.close();
  const changed = {
    ...context.manifest,
    compiler: { ...context.manifest.compiler, defaultTool: { id: 'BadMarkerTool', executable: '.uel' } },
  };
  await fs.writeFile(path.join(context.directory, 'manifest.json'), JSON.stringify(changed));
  const manager = context.makeManager();
  const state = await manager.discover();
  assert.equal(state.plugins.length, 0);
  assert.match(state.errors[0].message, /Path/);
});

test('loaded package changes require restarting the host rather than reusing cached ESM dependencies', async (t) => {
  const context = await fixture(t);
  await fs.writeFile(path.join(context.directory, 'helper.mjs'), 'export const version = 1;');
  await fs.appendFile(path.join(context.directory, 'runtime.mjs'), "\nimport './helper.mjs';\n");
  await context.manager.discover();
  context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  await context.manager.invokeDebug(context.id, 'state', []);
  await fs.writeFile(path.join(context.directory, 'helper.mjs'), 'export const version = 2;');
  await assert.rejects(() => context.manager.invokeDebug(context.id, 'action', ['pause']), /RestartRequired/);
  const state = await context.manager.state();
  assert.equal(state.plugins[0].restartRequired, true);
  assert.equal(state.plugins[0].trust, 'required');
  await assert.rejects(
    () =>
      context.manager.trust({
        id: context.id,
        fingerprint: state.plugins[0].fingerprint,
        confirm: true,
        permanent: false,
      }),
    /RestartRequired/,
  );
  assert.equal((globalThis as any)[context.marker], 1);
});

test('chip constraints and disabled capabilities apply even when compiler compatibility is forced', async (t) => {
  const context = await fixture(t);
  await context.manager.discover();
  const [runtime] = context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  const wrong = {
    ...context.config,
    programmer: { ...context.config.programmer, targetChipId: '0x415' },
    runtime: { forceCompiler: true },
  };
  assert.throws(() => getBoardAdapter(context.id).validateConfig(wrong), /Chip/);
  await assert.rejects(
    () =>
      runtime.flash(wrong, {
        success: true,
        flashUsed: 0,
        ramUsed: 0,
        flashTotal: 65536,
        ramTotal: 20480,
        artifacts: [],
        timestamp: new Date().toISOString(),
        output: '',
      }),
    /Chip/,
  );
  await assert.rejects(
    () =>
      runtime.build({ ...context.config, runtime: { disabledCapabilities: ['compile'] } }, { entry: '.' }),
    /Capability/,
  );
  assert.equal((globalThis as any)[context.marker], undefined);
});

test('plugin return values cannot inject source paths outside the workspace', async (t) => {
  const context = await fixture(t);
  const file = path.join(context.directory, 'runtime.mjs');
  await fs.writeFile(
    file,
    (await fs.readFile(file, 'utf8')).replace(
      "artifacts:['.blode/build/plugin.bin']",
      "artifacts:['../outside.bin']",
    ),
  );
  await context.manager.discover();
  const [runtime] = context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  await assert.rejects(() => runtime.build(context.config, { entry: '.' }), /Result/);
  assert.equal((await context.manager.state()).plugins[0].trust, 'session');
});

test('a user can force an explicitly selected built-in backend outside the author compatibility declaration', async (t) => {
  const context = await fixture(t, (manifest) => {
    delete manifest.compiler.baseRuntime;
  });
  await context.manager.discover();
  const profile = { c: { family: 'gnu-arm' as const, version: '15.2.1' } };
  const base = {
    id: 'STM32F103C8T6',
    build: async (config: ProjectConfig, inputs: any) => {
      assert.equal(config.boardId, 'STM32F103C8T6');
      assert.deepEqual(inputs.settings.platforms.STM32F103C8T6, profile);
      return {
        success: true,
        flashUsed: 0,
        ramUsed: 0,
        flashTotal: config.flashSize,
        ramTotal: 20480,
        artifacts: [],
        timestamp: new Date().toISOString(),
        output: 'explicit backend',
      };
    },
  } as unknown as PlatformRuntime;
  const [runtime] = context.manager.attach(context.host, [base]);
  await assert.rejects(() => context.manager.assertTrusted(context.id), /TrustRequired/);
  await authorize(context.manager, context.id);
  await context.manager.assertTrusted(context.id);
  const result = await runtime.build(
    { ...context.config, runtime: { forceCompiler: true, compilerRuntime: 'STM32F103C8T6' } },
    { settings: { platforms: { [context.id]: profile } } },
  );
  assert.equal(result.output, 'explicit backend');
  assert.equal(
    (globalThis as any)[context.marker],
    undefined,
    'author code need not run for a host compiler override',
  );
});

test('missing package files degrade status and report a diagnostic without blocking other runtimes', async (t) => {
  const context = await fixture(t);
  await context.manager.discover();
  const [runtime] = context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  assert.equal(path.dirname(context.directory), path.join(context.root, 'plugins'));
  await fs.rm(context.directory, { recursive: true, force: true });
  assert.deepEqual((await runtime.status(context.config, true)).versions, {});
  const state = await context.manager.state();
  assert.equal(state.plugins[0].trust, 'required');
  assert.ok(state.errors.some((error) => error.directory === context.directory));
  await assert.rejects(() => runtime.build(context.config, { entry: '.' }));
  assert.ok(getBoardAdapter('STM32F103C8T6'));
});

test('a probe cannot declare a chip outside the package constraints', async (t) => {
  const context = await fixture(t);
  const file = path.join(context.directory, 'runtime.mjs');
  await fs.writeFile(
    file,
    (await fs.readFile(file, 'utf8')).replace(
      "{output:'probe fixture',config}",
      "{output:'probe fixture',config:{...config,programmer:{...config.programmer,targetChipId:'0x415'}}}",
    ),
  );
  await context.manager.discover();
  const [runtime] = context.manager.attach(context.host, []);
  await authorize(context.manager, context.id);
  await assert.rejects(() => runtime.probe(context.config), /Chip/);
  assert.equal((await runtime.status(context.config)).versions.fixture, '1.0.0');
});

test('compiler provider inputs include declared and dynamic binary assets and reject workspace escapes', async (t) => {
  const context = await fixture(t, (manifest) => {
    manifest.sourceInputs = ['assets/declared.dat'];
  });
  await fs.mkdir(path.join(context.project, 'assets'));
  for (const name of ['declared', 'runtime', 'dynamic'])
    await fs.writeFile(path.join(context.project, 'assets', name + '.dat'), Buffer.from([1, 2, 3]));
  const entry = path.join(context.directory, 'runtime.mjs');
  const source = (await fs.readFile(entry, 'utf8'))
    .replace('sourceInputs:[]', "sourceInputs:['assets/runtime.dat']")
    .replace(
      'async install(){return this.status()},',
      "async install(){return this.status()},async buildInputs(config){return config.runtime?.values?.outside ? ['../outside.bin'] : ['assets/dynamic.dat']},",
    );
  await fs.writeFile(entry, source);
  await context.manager.discover();
  context.manager.attach(context.host, []);
  const target = { ...getBoardAdapter('STM32F103C8T6').createConfig(), runtime: { forceCompiler: true } };
  const inputs = { settings: { common: { family: 'plugin' as const, pluginId: context.id } } };
  assert.deepEqual(await context.manager.compilerInputs(target, {}), []);
  await assert.rejects(() => context.manager.compilerInputs(target, inputs), /TrustRequired/);
  await authorize(context.manager, context.id);
  assert.deepEqual((await context.manager.compilerInputs(target, inputs)).slice().sort(), [
    'assets/declared.dat',
    'assets/dynamic.dat',
    'assets/runtime.dat',
  ]);
  await assert.rejects(
    () =>
      context.manager.compilerInputs(
        { ...target, runtime: { forceCompiler: true, values: { outside: true } } },
        inputs,
      ),
    /Result/,
  );
});
