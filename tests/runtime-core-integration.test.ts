import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCore } from '../src/core/service';
import { SerialConnection } from '../src/core/serial';
import { Drivers } from '../src/core/drivers';
import { getBoardAdapter } from '../extensions/registry';
import { createHostServices } from '../src/core/host-services';
import { CollaborationService } from '../src/core/collaboration';
import { FirmwareStore } from '../src/core/firmware';
import { RecentProjects } from '../src/core/recent-projects';
import type { RuntimePluginManifest } from '../src/shared/plugins';
import type { LogEvent } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-runtime-core-'));
  const id = `Core_${randomUUID().replaceAll('-', '')}`;
  const directory = path.join(root, 'plugins', id);
  const project = path.join(root, 'project');
  const dataRoot = path.join(root, 'data');
  const executionMarker = `${id}_executions`;
  await fs.mkdir(path.join(directory, 'tools'), { recursive: true });
  await fs.mkdir(project);
  const config = {
    ...getBoardAdapter('STM32F103C8T6').createConfig(),
    boardId: id,
    programmer: { transport: 'usb' as const, serialNumber: '', frequencyKhz: 1800 },
    runtime: { deviceId: 'usb-fixture-7', values: { channel: 'A', speed: 10 }, forceCompiler: false },
  };
  const manifest: RuntimePluginManifest = {
    apiVersion: 2,
    runtimeApiVersion: 2,
    kind: 'board',
    id,
    name: 'Core USB fixture',
    version: '1.0.0',
    runtime: 'runtime.mjs',
    transport: 'usb',
    capabilities: ['compile', 'flash', 'probe', 'layout'],
    support: { chips: ['Fixture F103'], status: 'experimental' },
    defaultConfig: config,
    compiler: {
      mode: 'plugin',
      defaultTool: { id: 'Compiler', executable: 'tools/compiler.mjs', runner: 'node' },
    },
    debugger: { mode: 'none' },
    layout: { flashBaseAddress: 0x08000000, recommendedFlashSizes: [65536], ramSize: 20480 },
    constraints: { chipIds: ['0x410'] },
    ui: {
      fields: [
        { id: 'channel', label: 'Channel', type: 'text' },
        { id: 'speed', label: 'Speed', type: 'number', min: 1, max: 100 },
      ],
    },
  };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'tools/compiler.mjs'), 'console.log("isolated fixture compiler");');
  await fs.writeFile(
    path.join(directory, 'runtime.mjs'),
    `
import fs from 'node:fs/promises';
globalThis[${JSON.stringify(executionMarker)}]=(globalThis[${JSON.stringify(executionMarker)}]??0)+1;
export function createRuntime(host,manifest){return {
 id:manifest.id,transport:'usb',sourceInputs:[],invalidate(){},
 async status(){return {arduinoCli:false,esp32Core:false,python:false,esptool:false,versions:{fixture:'1'}}},
 async install(){return this.status()},
 async discover(){return [{id:manifest.id+':7',platformId:manifest.id,transport:'usb',name:'USB fixture',deviceId:'usb-fixture-7'}]},
 async probe(config,selection){
  if(selection?.deviceId!==config.runtime.deviceId)throw new Error('fixture selection.deviceId missing');
  return {config,output:'selected='+selection.deviceId};
 },
 async build(config){
  const output=await host.resetDirectory('.blode/build');
  const tool=await host.runDefaultTool();if(tool.code!==0)throw new Error(tool.output);
  await fs.writeFile(output+'/firmware.bin',Buffer.from([1,2,3,4]));
  return {success:true,flashUsed:4,ramUsed:0,flashTotal:config.flashSize,ramTotal:20480,artifacts:['.blode/build/firmware.bin'],timestamp:new Date().toISOString(),output:tool.output};
 },
 async flash(){throw new Error('fixture must not flash hardware')},
};}
`,
  );
  await fs.writeFile(path.join(project, 'main.c'), 'int main(void) { return 0; }\n');
  await fs.writeFile(
    path.join(project, 'be'),
    JSON.stringify({ ...config, build: { entry: 'main.c', cStandard: 'c99' } }),
  );
  t.mock.method(SerialConnection, 'list', async () => []);
  t.mock.method(Drivers.prototype, 'statuses', async () => []);
  const events: LogEvent[] = [];
  const core = await createCore({
    projectRoot: project,
    dataRoot,
    pluginRoots: [path.join(root, 'plugins')],
    refreshDevices: false,
    createRuntimes: () => [],
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await core.shutdown();
    delete (globalThis as Record<string, unknown>)[executionMarker];
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-runtime-core-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const authorize = async (permanent = false) => {
    const plugin = (await core.runtimePlugins.state()).plugins.find((item) => item.id === id)!;
    return core.runtimePlugins.trust({ id, fingerprint: plugin.fingerprint, confirm: true, permanent });
  };
  return { root, directory, project, dataRoot, id, config, core, executionMarker, events, authorize };
}

test('Core opens a preselected untrusted USB project without executing plugin code, then builds after explicit approval', async (t) => {
  const context = await fixture(t);
  const initial = await context.core.getState();
  assert.equal(initial.config.boardId, context.id);
  assert.equal(initial.workspaceOpen, true);
  assert.ok(initial.files.some((file) => file.path === 'main.c'));
  assert.equal(initial.runtimePlugins?.plugins[0].trust, 'required');
  assert.equal((globalThis as Record<string, unknown>)[context.executionMarker], undefined);
  await assert.rejects(context.core.build(), /runtimePluginTrustRequired/);
  assert.equal((globalThis as Record<string, unknown>)[context.executionMarker], undefined);
  await context.authorize(true);
  const output = await context.core.probe();
  assert.equal(output, 'selected=usb-fixture-7');
  const built = await context.core.build();
  assert.equal(built.success, true);
  assert.match(built.output, /isolated fixture compiler/);
  assert.deepEqual(
    await fs.readFile(path.join(context.project, '.blode/build/firmware.bin')),
    Buffer.from([1, 2, 3, 4]),
  );
  const after = await context.core.getState();
  assert.equal(after.lastBuild?.success, true);
  assert.equal(after.buildStale, false);
  assert.equal((globalThis as Record<string, unknown>)[context.executionMarker], 1);
  await fs.unlink(path.join(context.directory, '.uel'));
  await assert.rejects(context.core.probe(), /runtimePluginTrustRequired/);
  await assert.rejects(context.core.build(), /runtimePluginTrustRequired/);
  const revoked = await context.core.getState();
  assert.equal(revoked.runtimePlugins?.plugins[0].trust, 'required');
  assert.equal(revoked.buildStale, true);
  assert.equal(revoked.workspaceOpen, true);
  await context.core.saveConfig({ ...getBoardAdapter('auto').createConfig(), name: 'Recovered project' });
  assert.equal((await context.core.getState()).config.boardId, 'auto');
});

test('host plugin configuration patches preserve other values and reject iframe privilege fields', async (t) => {
  const context = await fixture(t);
  const collaboration = new CollaborationService({
    workspace: () => context.core.workspaceSnapshot(),
    saveFile: (file, content) => context.core.saveFile(file, content),
    publish() {},
  });
  const services = createHostServices({
    core: context.core,
    collaboration,
    firmware: new FirmwareStore(context.dataRoot),
    recent: new RecentProjects(path.join(context.dataRoot, 'recent.json')),
    dataRoot: context.dataRoot,
    toolchainRoot: path.join(context.root, 'tools'),
    emit() {},
  });
  t.after(async () => {
    collaboration.dispose();
    await services.close();
  });
  await services.invoke('runtimePluginConfigure', [context.id, { values: { channel: 'B' } }]);
  const updated = context.core.currentConfig();
  assert.deepEqual(updated.runtime?.values, { channel: 'B', speed: 10 });
  assert.equal(updated.runtime?.deviceId, 'usb-fixture-7');
  assert.equal(updated.runtime?.forceCompiler, false);
  for (const invalid of [
    { forceCompiler: true },
    { compilerRuntime: 'STM32F103C8T6' },
    { values: { speed: 1000 } },
  ])
    await assert.rejects(
      services.invoke('runtimePluginConfigure', [context.id, invalid]),
      /invalidParams|runtimePluginConfig/,
    );
  assert.equal(
    (globalThis as Record<string, unknown>)[context.executionMarker],
    undefined,
    'configuration and its rejection do not execute plugin code',
  );
  const contextValue = (await services.invoke('runtimePluginContext', [context.id])) as {
    values: Record<string, unknown>;
  };
  assert.deepEqual(contextValue.values, { channel: 'B', speed: 10 });
});
