import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { packageRuntime } from '../scripts/package-runtime';
import { getBoardAdapter } from '../extensions/registry';
import { RuntimePlugins } from '../src/core/runtime-plugins';
import { parseRuntimePluginManifest } from '../src/core/runtime-plugin-schema';
import type { RuntimeHost, PlatformRuntime } from '../extensions/runtime';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-package-runtime-test-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  const id = 'Packaged_' + randomUUID().replaceAll('-', '');
  await fs.mkdir(path.join(source, 'runtime'), { recursive: true });
  await fs.mkdir(path.join(source, 'ui'));
  const manifest = {
    apiVersion: 2,
    runtimeApiVersion: 2,
    kind: 'board',
    id: 'SourceFixture',
    name: 'Portable fixture',
    version: '1.0.0',
    runtime: 'runtime/index.ts',
    transport: 'stlink',
    capabilities: ['compile', 'probe', 'flash'],
    support: { chips: ['STM32F103C8T6'], status: 'experimental' },
    defaultConfig: { ...getBoardAdapter('STM32F103C8T6').createConfig(), boardId: 'SourceFixture' },
    compiler: {
      mode: 'runtime',
      baseRuntime: 'STM32F103C8T6',
      managedTools: [{ id: 'test-compiler', name: 'Test compiler' }],
    },
    debugger: { mode: 'builtin' },
    layout: { recommendedFlashSizes: [65536], ramSize: 20480 },
    constraints: {},
    ui: { fields: [], views: [{ id: 'report', label: 'Report', file: 'ui/report.html', location: 'panel' }] },
  };
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(
    path.join(source, 'ui/report.html'),
    '<script>document.body.textContent="report";</script>',
  );
  await fs.writeFile(path.join(source, 'ui/report.js'), 'document.body.textContent="report";');
  await fs.writeFile(path.join(source, '.uel'), 'trust must not be shared');
  await fs.writeFile(
    path.join(source, 'runtime/index.ts'),
    `
import { readFile } from 'node:fs/promises';
import path from 'node:path';
export function createRuntime(host, manifest) {
  return { id: manifest.id, transport:'stlink', sourceInputs:[], invalidate(){},
    async status(){return {arduinoCli:false,esp32Core:false,python:false,esptool:false,versions:{fixture:'1.0'}}},
    async install(){return this.status()},
    async discover(){return [{id:'probe',platformId:manifest.id,transport:'stlink',name:'fixture'}]},
    async probe(config){return {output:'ok',config}},
    async build(config,inputs){
      if(config.boardId!==manifest.id || inputs.settings?.platforms?.[manifest.id]?.common?.mode!=='custom') throw Error('mapping lost');
      const resource=await readFile(path.join(host.pluginRoot,'ui/report.html'),'utf8');
      const result=await host.runCommand('fixture-compiler',[],{cwd:host.projectRoot()});
      return {success:true,flashUsed:0,ramUsed:0,flashTotal:65536,ramTotal:20480,artifacts:[],timestamp:new Date().toISOString(),output:resource+result.output};
    },async flash(){}
  };
}`,
  );
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-package-runtime-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, source, output, id, manifest };
}

test('published JS runtime loads without source and compiles through SDK host rather than builtin compiler', async (t) => {
  const f = await fixture(t);
  const built = await packageRuntime({ source: f.source, output: f.output, id: f.id, zip: true });
  assert.equal(built.manifest.runtime, 'runtime/index.mjs');
  assert.equal(built.manifest.compiler.mode, 'runtime');
  assert.equal((await fs.readFile(built.archive!)).readUInt32LE(), 0x04034b50);
  assert.equal(await fs.stat(path.join(built.directory, 'runtime/index.ts')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(built.directory, '.uel')).catch(() => null), null);
  // Remove the test source entry to prove the generated runtime is self contained.
  await fs.unlink(path.join(f.source, 'runtime/index.ts'));
  const manager = new RuntimePlugins({ roots: [f.output], dataRoot: path.join(f.root, 'data') });
  t.after(() => manager.close());
  const state = await manager.discover();
  assert.deepEqual(state.errors, []);
  assert.equal(state.plugins.length, 1);
  const plugin = state.plugins[0];
  assert.equal(plugin.trust, 'required');
  await manager.trust({ id: f.id, fingerprint: plugin.fingerprint, confirm: true, permanent: false });
  const commands: string[] = [];
  const host: RuntimeHost = {
    dataRoot: path.join(f.root, 'data'),
    signal: new AbortController().signal,
    emit() {},
    projectRoot: () => f.root,
    readProjectFiles: async () => [],
    listPorts: async () => [],
    requirePort: async () => {
      throw Error('no hardware');
    },
    closeSerial: async () => {},
    resolveWorkspacePath: async (relative) => path.join(f.root, relative),
    resetDirectory: async () => f.root,
    runCommand: async (command) => {
      commands.push(command);
      return { code: 0, output: 'sdk host called' };
    },
  };
  const base = {
    id: 'STM32F103C8T6',
    build: async () => {
      throw Error('builtin must not compile runtime packages');
    },
  } as unknown as PlatformRuntime;
  const [runtime] = manager.attach(host, [base]);
  const config = built.manifest.defaultConfig;
  const result = await runtime.build(config, {
    settings: { platforms: { [f.id]: { common: { mode: 'custom' } } } },
  } as any);
  assert.equal(result.success, true);
  assert.match(result.output, /sdk host called/);
  assert.deepEqual(commands, ['fixture-compiler']);
  assert.equal((await runtime.discover(config))[0].platformId, f.id);
  assert.equal((await runtime.probe(config)).config.boardId, f.id);
});

test('runtime mode requires nonempty unique managed tool declarations and plugin mode still needs its payload', async (t) => {
  const f = await fixture(t);
  const manifest = { ...f.manifest, runtime: 'runtime/index.mjs' };
  assert.equal(parseRuntimePluginManifest(manifest).compiler.mode, 'runtime');
  for (const compiler of [
    { mode: 'runtime' },
    { mode: 'runtime', managedTools: [] },
    {
      mode: 'runtime',
      managedTools: [
        { id: 'x', name: 'x' },
        { id: 'x', name: 'x' },
      ],
    },
    { mode: 'plugin', managedTools: [{ id: 'x', name: 'x' }] },
  ])
    assert.throws(() => parseRuntimePluginManifest({ ...manifest, compiler }), /runtimePluginManifest/);
});

test('packaging refuses overwrites, source-contained outputs and private host implementation imports', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    packageRuntime({ source: f.source, output: path.join(f.source, 'dist') }),
    /outside the source/,
  );
  const built = await packageRuntime({ source: f.source, output: f.output, id: f.id });
  const entry = await fs.readFile(path.join(built.directory, built.manifest.runtime), 'utf8');
  await assert.rejects(packageRuntime({ source: f.source, output: f.output, id: f.id }), /already exists/);
  assert.equal(await fs.readFile(path.join(built.directory, built.manifest.runtime), 'utf8'), entry);
  await fs.writeFile(
    path.join(f.source, 'runtime/index.ts'),
    `export { createRuntime } from ${JSON.stringify(path.resolve('src/core/process.ts'))};`,
  );
  await assert.rejects(
    packageRuntime({ source: f.source, output: f.output, id: f.id + '_Rejected' }),
    /public host SDK/,
  );
  await fs.writeFile(
    path.join(f.source, 'runtime/index.ts'),
    `export { createStm32Runtime as createRuntime } from ${JSON.stringify(path.resolve('extensions/boards/STM32F103C8T6/runtime/index.ts'))};`,
  );
  await assert.rejects(
    packageRuntime({ source: f.source, output: f.output, id: f.id + '_CrossBoard' }),
    /another board implementation/,
  );
});

test('literal import.meta.url resources relocate with the bundle and dynamic paths are rejected', async (t) => {
  const f = await fixture(t);
  const manifest = { ...f.manifest, runtime: 'index.ts' };
  await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(f.source, 'payload.json'), JSON.stringify({ value: 'packaged resource' }));
  await fs.writeFile(
    path.join(f.source, 'index.ts'),
    `import { readFile } from 'node:fs/promises'; export async function createRuntime(){ return JSON.parse(await readFile(new URL('./payload.json', import.meta.url), 'utf8')); }`,
  );
  const built = await packageRuntime({ source: f.source, output: f.output, id: f.id });
  await fs.unlink(path.join(f.source, 'payload.json'));
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(path.join(built.directory, built.manifest.runtime)).href);
  assert.equal((await module.createRuntime({}, built.manifest)).id, f.id);
  // The factory above successfully reads the packaged JSON before the wrapper returns.
  await fs.writeFile(
    path.join(f.source, 'index.ts'),
    `export function createRuntime(host){ return new URL(host.resourceName, import.meta.url); }`,
  );
  await assert.rejects(
    packageRuntime({ source: f.source, output: f.output, id: f.id + '_Dynamic' }),
    /use host.pluginRoot/,
  );
});

test('unsupported view asset links fail packaging with inline guidance', async (t) => {
  const f = await fixture(t);
  for (const [index, html] of [
    '<script src="report.js"></script>',
    '<link rel="stylesheet" href="report.css">',
    '<img src="logo.svg">',
    '<img src="blob:some-url">',
    '<video src="data:video/mp4;base64,AAAA"></video>',
    '<style>.hero{background:url(logo.svg)}</style>',
  ].entries()) {
    await fs.writeFile(path.join(f.source, 'ui/report.html'), html);
    await assert.rejects(
      packageRuntime({ source: f.source, output: f.output, id: `${f.id}_${index}` }),
      /inline|data URLs/,
    );
  }
  await fs.writeFile(
    path.join(f.source, 'ui/report.html'),
    '<style>.hero{background:url("data:image/svg+xml;base64,AAAA")}</style><img src="data:image/png;base64,AAAA">',
  );
  await packageRuntime({ source: f.source, output: f.output, id: `${f.id}_Inline` });
});

test('builtin factory keeps its optional programmer argument instead of receiving the manifest', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.source, 'manifest.json'),
    JSON.stringify({
      ...f.manifest,
      id: 'STM32F103C8T6',
      defaultConfig: { ...f.manifest.defaultConfig, boardId: 'STM32F103C8T6' },
      compiler: { mode: 'host', baseRuntime: 'STM32F103C8T6' },
    }),
  );
  await fs.writeFile(
    path.join(f.source, 'runtime/index.ts'),
    `
export function createStm32Runtime(host, programmer = { async status(){ return { stlink:true }; } }) {
  return { id:'STM32F103C8T6',transport:'stlink',sourceInputs:[],invalidate(){},
    async status(){return {arduinoCli:false,esp32Core:false,python:false,esptool:false,versions:{},...await programmer.status()};},
  };
}`,
  );
  const built = await packageRuntime({ source: f.source, output: f.output });
  assert.equal(built.manifest.id, 'STM32F103C8T6_Module');
  assert.equal(built.manifest.compiler.mode, 'runtime');
  assert.ok(built.manifest.compiler.managedTools?.length);
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(path.join(built.directory, built.manifest.runtime)).href);
  const runtime = await module.createRuntime({}, built.manifest);
  assert.equal((await runtime.status(built.manifest.defaultConfig)).stlink, true);
});
