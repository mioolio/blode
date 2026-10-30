import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCore } from '../src/core/service';
import { parseProjectBuild } from '../src/core/config';
import { getBoardAdapter } from '../extensions/registry';
import type { CreatePlatformRuntimes } from '../extensions/runtime';
import { SerialConnection } from '../src/core/serial';
import { Drivers } from '../src/core/drivers';
import { prepareBuildExport } from '../src/core/firmware';
import { protectSharedWorkspace } from '../src/core/shared-workspace';
import { CollaborationService } from '../src/core/collaboration';
import { RuntimeDebugger } from '../src/core/runtime-debugger';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { createWebDebugger } from '../src/core/web-debugger';
import { resolveBuildDebugSymbols } from '../src/core/build-debug-symbols';

test('target schema rejects duplicate ids, recursive targets, escaping roots and missing defaults', () => {
  const valid = {
    id: 'control',
    name: 'Control',
    root: 'projects/control',
    build: { entry: 'main.c', cStandard: 'c99' },
  };
  assert.equal(
    parseProjectBuild({ targets: [valid], defaultTarget: 'control' }).targets?.[0].root,
    'projects/control',
  );
  for (const targets of [
    [valid, valid],
    [valid, { ...valid, id: 'CONTROL' }],
    [{ ...valid, root: '../outside' }],
    [{ ...valid, root: 'C:/outside' }],
    [{ ...valid, root: 'a/../b' }],
    [{ ...valid, build: { targets: [] } }],
  ])
    assert.throws(() => parseProjectBuild({ targets }), /invalidProjectDescriptor/);
  assert.throws(
    () => parseProjectBuild({ targets: [valid], defaultTarget: 'missing' }),
    /invalidProjectDescriptor/,
  );
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-multi-target-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  config.port = 'CURRENT-COM';
  config.programmer!.serialNumber = 'AABBCCDD11223344';
  const targets = ['control', 'sensor'].map((id) => ({ id, name: id.toUpperCase(), root: id }));
  for (const [index, target] of targets.entries()) {
    const directory = path.join(workspace, target.root);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'main.c'), `int main(void) { return ${index + 1}; }`);
    await fs.writeFile(
      path.join(directory, 'be'),
      JSON.stringify({
        ...config,
        port: 'OLD-COM',
        programmer: { ...config.programmer, serialNumber: '11223344AABBCCDD' },
        build: {
          entry: 'main.c',
          cStandard: index ? 'c17' : 'c99',
          settings: { mode: index ? 'release' : 'debug' },
        },
      }),
    );
  }
  await fs.writeFile(
    path.join(workspace, 'be'),
    JSON.stringify({ ...config, build: { targets, settings: { common: { family: 'gnu-arm' } } } }),
  );
  const calls: { root: string; standard?: string; mode?: string; family?: string }[] = [],
    flashes: { port: string; serial?: string; root: string }[] = [];
  t.mock.method(SerialConnection, 'list', async () => [{ path: 'CURRENT-COM' }]);
  t.mock.method(Drivers.prototype, 'statuses', async () => []);
  const createRuntimes: CreatePlatformRuntimes = (host) => [
    {
      id: config.boardId,
      transport: 'stlink',
      sourceInputs: [],
      projectConfig: async (value, inputs) =>
        value.boardId === 'auto' && inputs.entry ? getBoardAdapter('STM32F103C8T6').createConfig() : null,
      status: async () => ({
        arduinoCli: false,
        esp32Core: false,
        python: false,
        esptool: false,
        versions: {},
      }),
      install: async () => {
        throw new Error('installation forbidden');
      },
      discover: async () => [],
      probe: async () => {
        throw new Error('physical probe forbidden');
      },
      invalidate() {},
      build: async (_config, inputs) => {
        const directory = await host.resetDirectory('.blode/build');
        calls.push({
          root: host.projectRoot(),
          standard: inputs.cStandard,
          mode: inputs.settings?.mode,
          family: inputs.settings?.common?.family,
        });
        // An actual isolated subprocess reads only its own target source and writes its output.
        const output = await host.runCommand(
          process.execPath,
          [
            '-e',
            "const f=require('fs');f.writeFileSync(process.argv[1],f.readFileSync('main.c'));",
            path.join(directory, 'firmware.bin'),
          ],
          { cwd: host.projectRoot() },
        );
        const elf = Buffer.alloc(84);
        elf.write('7f454c46', 'hex');
        elf[4] = elf[5] = 1;
        elf.writeUInt16LE(40, 18);
        const source = await fs.readFile(path.join(host.projectRoot(), 'main.c'), 'utf8');
        elf[83] = Number(/return (\d)/.exec(source)?.[1] ?? 0);
        await fs.writeFile(path.join(directory, 'firmware.elf'), elf);
        return {
          success: output.code === 0,
          flashUsed: 32,
          ramUsed: 4,
          flashTotal: 65536,
          ramTotal: 20480,
          artifacts: ['.blode/build/firmware.bin'],
          timestamp: new Date().toISOString(),
          output: output.output,
        };
      },
      flash: async (value) => {
        flashes.push({ port: value.port, serial: value.programmer?.serialNumber, root: host.projectRoot() });
      },
    },
  ];
  const open = () =>
    createCore({
      projectRoot: workspace,
      dataRoot: path.join(root, 'data'),
      onEvent: () => {},
      createRuntimes,
      refreshDevices: false,
    });
  let core = await open();
  t.after(async () => {
    await core.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    config,
    targets,
    calls,
    flashes,
    get core() {
      return core;
    },
    async restart() {
      await core.shutdown();
      core = await open();
    },
  };
}

test('two targets compile offline with independent contexts, settings, caches and export; the workspace remains unchanged', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.core.build(), /selectBuildTarget/);
  const a = await f.core.build('control'),
    b = await f.core.build('sensor');
  assert.deepEqual(a.artifacts, ['control/.blode/targets/control/build/firmware.bin']);
  assert.deepEqual(b.artifacts, ['sensor/.blode/targets/sensor/build/firmware.bin']);
  assert.deepEqual(
    f.calls.map((call) => [path.basename(call.root), call.standard, call.mode, call.family]),
    [
      ['control', 'c99', 'debug', 'gnu-arm'],
      ['sensor', 'c17', 'release', 'gnu-arm'],
    ],
  );
  assert.equal(f.core.currentProjectRoot(), f.workspace);
  assert.equal(f.core.currentConfig().port, 'CURRENT-COM');
  assert.match(await fs.readFile(path.join(f.workspace, a.artifacts[0]), 'utf8'), /return 1/);
  assert.match(await fs.readFile(path.join(f.workspace, b.artifacts[0]), 'utf8'), /return 2/);
  const state = await f.core.getState();
  assert.equal(state.buildTarget?.id, 'sensor');
  assert.equal(state.buildStale, false);
  const exported = await prepareBuildExport(f.workspace, state, 'bin');
  assert.match(exported.data.toString(), /return 2/);
  assert.equal(exported.defaultName, 'SENSOR.bin');
  await f.core.flash();
  assert.deepEqual(f.flashes, [
    { port: 'CURRENT-COM', serial: 'AABBCCDD11223344', root: path.join(f.workspace, 'sensor') },
  ]);
  const evidence = await f.core.buildEvidenceState();
  assert.equal(evidence.records?.filter((record) => record.success && !record.stale).length, 2);
  await f.restart();
  assert.equal((await f.core.getState()).buildTarget?.id, 'sensor');
  assert.equal((await f.core.getState()).lastBuild?.timestamp, b.timestamp);
  assert.equal((await f.core.getState()).buildStale, false);
  await fs.writeFile(path.join(f.workspace, 'control', 'main.c'), 'int main(void) { return 3; }');
  const changed = await f.core.getState();
  assert.equal(changed.targetBuilds?.find((target) => target.id === 'control')?.stale, true);
  assert.equal(changed.targetBuilds?.find((target) => target.id === 'sensor')?.stale, false);
});

test('one target compiles directly, target overrides inherit language settings, and deleting a target removes its active result', async (t) => {
  const f = await fixture(t);
  await f.core.saveFile(
    'be',
    JSON.stringify({
      ...f.config,
      build: {
        targets: [{ ...f.targets[0], build: { cStandard: 'c11', settings: { optimizeForSize: true } } }],
      },
    }),
  );
  assert.equal((await f.core.build()).success, true);
  assert.equal(f.calls[0].standard, 'c11');
  assert.equal(f.calls[0].mode, 'debug');
  const descriptor = { ...f.config, build: { entry: 'main.c' } };
  await fs.writeFile(path.join(f.workspace, 'main.c'), 'int main(void){return 0;}');
  await f.core.saveFile('be', JSON.stringify(descriptor));
  assert.equal((await f.core.getState()).buildTarget, undefined);
  const legacy = await f.core.build();
  assert.deepEqual(legacy.artifacts, ['.blode/build/firmware.bin']);
  assert.equal((await f.core.getState()).buildTarget, undefined);
  await assert.rejects(f.core.build('deleted'), /invalidBuildTarget/);
});

test('target selection rejects symlinks, stale binaries and mismatching current hardware platforms', async (t) => {
  const f = await fixture(t);
  await f.core.build('control');
  await fs.writeFile(
    path.join(f.workspace, 'control', '.blode/targets/control/build/firmware.bin'),
    'tampered',
  );
  await assert.rejects(f.core.flash(), /buildRequired/);
  assert.equal(f.flashes.length, 0);
  await f.core.build('control');
  await f.core.saveConfig(getBoardAdapter('Esp32_S3_CAM').createConfig());
  await assert.rejects(f.core.flash(), /targetDeviceMismatch/);
  assert.equal(f.flashes.length, 0);
  await fs.symlink(
    path.join(f.workspace, 'sensor'),
    path.join(f.workspace, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await f.core.saveFile(
    'be',
    JSON.stringify({ ...f.config, build: { targets: [{ id: 'linked', name: 'Linked', root: 'linked' }] } }),
  );
  await assert.rejects(f.core.build('linked'), /symlinkPath/);
});

test('automatic target recognition restores across restart and a broken neighboring target stays isolated', async (t) => {
  const f = await fixture(t);
  const automatic = getBoardAdapter('auto').createConfig();
  await fs.writeFile(
    path.join(f.workspace, 'control', 'be'),
    JSON.stringify({ ...automatic, build: { entry: 'main.c' } }),
  );
  await f.core.saveFile(
    'be',
    JSON.stringify({
      ...f.config,
      build: { targets: [f.targets[0], { id: 'missing', name: 'Missing', root: 'not-created' }] },
    }),
  );
  assert.equal((await f.core.build('control')).success, true);
  const state = await f.core.getState();
  assert.equal(state.buildTarget?.config.boardId, 'STM32F103C8T6');
  assert.equal(state.targetBuilds?.find((target) => target.id === 'missing')?.stale, true);
  await f.restart();
  assert.equal((await f.core.getState()).buildStale, false);
  assert.equal((await f.core.getState()).buildTarget?.config.boardId, 'STM32F103C8T6');
  await fs.rm(path.join(f.workspace, 'control'), { recursive: true, force: true });
  assert.equal((await f.core.getState()).lastBuild, null);
  await assert.rejects(f.core.flash());
  assert.equal(f.flashes.length, 0);
});

test('targets sharing one source directory retain separate generated files and artifact validity', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, 'main.c'), 'int main(void){return 4;}');
  await f.core.saveFile(
    'be',
    JSON.stringify({
      ...f.config,
      build: {
        entry: 'main.c',
        targets: [
          { id: 'debug', name: 'Debug', root: '.', build: { settings: { mode: 'debug' } } },
          { id: 'release', name: 'Release', root: '.', build: { settings: { mode: 'release' } } },
        ],
      },
    }),
  );
  const debug = await f.core.build('debug'),
    release = await f.core.build('release');
  assert.deepEqual(debug.artifacts, ['.blode/targets/debug/build/firmware.bin']);
  assert.deepEqual(release.artifacts, ['.blode/targets/release/build/firmware.bin']);
  await fs.writeFile(path.join(f.workspace, debug.artifacts[0]), 'changed');
  const state = await f.core.getState();
  assert.equal(state.targetBuilds?.find((target) => target.id === 'debug')?.stale, true);
  assert.equal(state.targetBuilds?.find((target) => target.id === 'release')?.stale, false);
});

test('the real collaboration wrapper forwards each selected target and flushes a shared source before compiling', async (t) => {
  const f = await fixture(t),
    rawSave = f.core.saveFile.bind(f.core);
  const shared = new CollaborationService({
    workspace: () => f.core.workspaceSnapshot(),
    freshWorkspace: () => f.core.workspaceSnapshot(true),
    saveFile: rawSave,
    publish: () => {},
  });
  protectSharedWorkspace(f.core, shared);
  t.after(() => shared.dispose());
  const session = (await shared.state()).session;
  const document = await shared.open(f.workspace, 'control/main.c');
  await shared.edit({
    projectRoot: f.workspace,
    session,
    path: 'control/main.c',
    baseRevision: document.revision,
    peerId: 'peer-control',
    actorToken: 'a'.repeat(64),
    requestId: 'target-edit-1',
    changes: [{ start: 0, end: document.content.length, text: 'int main(void){return 7;}' }],
  });
  const control = await f.core.build('control'),
    sensor = await f.core.build('sensor');
  assert.match(await fs.readFile(path.join(f.workspace, control.artifacts[0]), 'utf8'), /return 7/);
  assert.match(await fs.readFile(path.join(f.workspace, sensor.artifacts[0]), 'utf8'), /return 2/);
  assert.deepEqual(
    f.calls.map((call) => path.basename(call.root)),
    ['control', 'sensor'],
  );
  assert.equal(
    (await shared.state()).documents.some((document) => document.dirty),
    false,
  );
});

test('desktop and browser debugger routes follow the latest verified target ELF, retain a manual ELF and clear invalid automatic symbols', async (t) => {
  const f = await fixture(t);
  t.mock.method(HardwareDebugger.prototype as any, 'tools', async () => ({
    gdb: 'fixture-gdb',
    server: 'fixture-server',
    scripts: null,
  }));
  const debug = new RuntimeDebugger(
    f.root,
    path.join(f.root, 'debugger'),
    undefined,
    () => f.core.runtimePlugins,
    () => f.core.currentConfig(),
    (config) => resolveBuildDebugSymbols(f.core, config),
  );
  t.after(() => debug.disconnect());
  const web = createWebDebugger(debug, f.core);
  await f.core.build('control');
  const first = await resolveBuildDebugSymbols(f.core, f.config);
  assert.equal(first?.bytes.at(-1), 1);
  assert.equal((await debug.state(f.config)).symbols, 'firmware.elf');
  const copiedFirst = (debug as any).symbols;
  await f.core.build('sensor');
  const second = await resolveBuildDebugSymbols(f.core, f.config);
  assert.equal(second?.bytes.at(-1), 2);
  assert.notEqual(first?.id, second?.id);
  assert.equal(((await web.invoke('debuggerState', [f.config])) as any).symbols, 'firmware.elf');
  assert.notEqual((debug as any).symbols, copiedFirst);
  assert.equal(
    await fs.access(copiedFirst).then(
      () => true,
      () => false,
    ),
    false,
    'replaced auto ELF is released',
  );
  assert.equal(await resolveBuildDebugSymbols(f.core, getBoardAdapter('Esp32_S3_CAM').createConfig()), null);
  const targetElf = path.join(f.workspace, 'sensor', '.blode/targets/sensor/build/firmware.elf');
  await fs.writeFile(targetElf, Buffer.alloc(84));
  assert.equal((await debug.state(f.config)).symbols, '');
  assert.equal(await debug.storage(), null, 'modified companion ELF cannot retain old automatic symbols');
  await f.core.build('sensor');
  await web.invoke('debuggerState', [f.config]);
  const manual = Buffer.from(second!.bytes);
  manual[83] = 9;
  await web.symbols(manual, 'chosen-by-user.elf');
  await f.core.build('control');
  assert.equal((await debug.state(f.config)).symbols, 'chosen-by-user.elf');
  assert.equal((await fs.readFile((debug as any).symbols)).at(-1), 9);
  await fs.rm(path.join(f.workspace, 'control'), { recursive: true, force: true });
  assert.equal(((await web.invoke('debuggerState', [f.config])) as any).symbols, 'chosen-by-user.elf');
  assert.equal(await resolveBuildDebugSymbols(f.core, f.config), null);
});
