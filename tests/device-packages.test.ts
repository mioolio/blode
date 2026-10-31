import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DevicePackages } from '../src/core/device-packages';
import { getBoardAdapter } from '../extensions/registry';
import { RuntimePlugins } from '../src/core/runtime-plugins';
import { readZip } from '../src/core/zip-reader';
import { buildDeviceModules } from '../scripts/build-device-modules';
import { parseRuntimePluginManifest } from '../src/core/runtime-plugin-schema';
import { createHostServices } from '../src/core/host-services';
import { createWorkbenchBridge } from '../src/shared/workbench-bridge';
import type { RuntimePluginInfo } from '../src/shared/plugins';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-device-packages-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^blode-device-packages-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const id = 'Device_' + randomUUID().replaceAll('-', '');
  const directory = path.join(root, 'plugins', id);
  await fs.mkdir(path.join(directory, 'runtime'), { recursive: true });
  const raw = {
    ...getBoardAdapter('STM32F103C8T6').definition.runtimePlugin!,
    id,
    name: 'Third party board',
    runtime: 'runtime/index.mjs',
    defaultConfig: { ...getBoardAdapter('STM32F103C8T6').createConfig(), boardId: id },
    languages: undefined,
    documentation: undefined,
  } as Record<string, unknown>;
  delete raw.entry;
  const manifest = parseRuntimePluginManifest(raw);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(
    path.join(directory, 'runtime/index.mjs'),
    'throw Error("must not execute while sharing");',
  );
  const plugins: RuntimePluginInfo[] = [
    { id, name: manifest.name, directory, manifest, trust: 'required', fingerprint: 'a'.repeat(64) },
  ];
  const packages = new DevicePackages({
    dataRoot: path.join(root, 'data'),
    builtinRoot: path.join(root, 'dist', 'device-modules'),
    plugins: async () => ({ plugins, errors: [] }),
  });
  return { root, directory, id, packages, plugins };
}

test('target devices list installed modules independently of compiler installations', async (t) => {
  const f = await fixture(t);
  const state = await f.packages.state();
  assert.deepEqual(
    state.packages.map((item) => item.id),
    ['Esp32_S3_CAM', 'STM32F103C8T6', f.id],
  );
  assert.deepEqual(
    state.packages.map((item) => item.source),
    ['builtin', 'builtin', 'plugin'],
  );
  assert.ok(!state.packages.some((item) => item.id === 'auto'));
  assert.equal(state.packages[0].exportId, 'Esp32_S3_CAM_Module');
  await assert.rejects(f.packages.export({ id: f.id, confirm: false as true }), /invalidArguments/);
});

test('third-party module ZIP retains resources without trust markers, local settings, secrets or executing its runtime', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.directory, '.vscode'));
  await fs.mkdir(path.join(f.directory, 'cache'));
  for (const relative of [
    '.uel',
    '.env',
    '.vscode/settings.json',
    'cache/index.bin',
    'secret.key',
    'credentials.json',
  ])
    await fs.writeFile(path.join(f.directory, relative), 'private');
  await fs.writeFile(path.join(f.directory, 'README.md'), 'Module readme');
  const result = await f.packages.export({ id: f.id, confirm: true });
  const downloaded = f.packages.download(result.id);
  assert.equal(downloaded.name, result.name);
  const bytes = await fs.readFile(downloaded.path),
    files = readZip(bytes);
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256.length, 64);
  assert.deepEqual(
    [...files.keys()].sort(),
    [
      `${f.id}/README.md`,
      `${f.id}/manifest.json`,
      `${f.id}/package-manifest.json`,
      `${f.id}/runtime/index.mjs`,
    ].sort(),
  );
  const receiver = path.join(f.root, 'receiver');
  for (const [relative, content] of files) {
    const target = path.join(receiver, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const manager = new RuntimePlugins({ roots: [receiver], dataRoot: path.join(f.root, 'receiver-data') });
  t.after(() => manager.close());
  const discovered = await manager.discover();
  assert.deepEqual(discovered.errors, []);
  assert.equal(discovered.plugins[0].id, f.id);
  assert.equal(discovered.plugins[0].trust, 'required');
});

test('built-in device exports contain standalone runtimes and module resources usable without the source tree', async (t) => {
  const f = await fixture(t);
  const output = path.join(f.root, 'dist');
  await buildDeviceModules(output);
  const receiver = path.join(f.root, 'receiver');
  for (const id of ['Esp32_S3_CAM', 'STM32F103C8T6']) {
    const result = await f.packages.export({ id, confirm: true });
    const files = readZip(await fs.readFile(f.packages.download(result.id).path));
    const prefix = id + '_Module/';
    const manifest = JSON.parse(files.get(prefix + 'manifest.json')!.toString());
    assert.equal(manifest.id, id + '_Module');
    assert.equal(manifest.runtime, 'runtime/index.mjs');
    assert.equal(manifest.compiler.mode, 'runtime');
    assert.ok(files.has(prefix + 'runtime/index.mjs'));
    assert.ok([...files.keys()].some((file) => file.startsWith(prefix + 'languages/')));
    assert.ok(![...files.keys()].some((file) => /\.(?:tsx?|map)$/.test(file) || file.includes('.vscode')));
    for (const [relative, content] of files) {
      const target = path.join(receiver, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  await fs.rename(output, output + '-removed');
  const manager = new RuntimePlugins({ roots: [receiver], dataRoot: path.join(f.root, 'receiver-data') });
  t.after(() => manager.close());
  const discovered = await manager.discover();
  assert.deepEqual(discovered.errors, []);
  assert.deepEqual(discovered.plugins.map((plugin) => plugin.id).sort(), [
    'Esp32_S3_CAM_Module',
    'STM32F103C8T6_Module',
  ]);
});

test('a declared resource cannot silently disappear from a shared module', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.directory, 'runtime', 'index.mjs'));
  await assert.rejects(f.packages.export({ id: f.id, confirm: true }), /runtimePluginPath/);
});

test('device export uses the common desktop bridge, save dialog and authenticated Web download registry', async (t) => {
  const f = await fixture(t);
  const saved: { path: string; name: string }[] = [];
  const services = createHostServices({
    core: {
      currentProjectRoot: () => '',
      currentConfig: () => getBoardAdapter('auto').createConfig(),
      runtimePlugins: { state: async () => ({ plugins: f.plugins, errors: [] }) },
    } as any,
    collaboration: {} as any,
    firmware: {} as any,
    recent: {} as any,
    dataRoot: path.join(f.root, 'host-data'),
    builtinDevicePackagesRoot: path.join(f.root, 'dist', 'device-modules'),
    toolchainRoot: path.join(f.root, 'absent-tools'),
    emit() {},
    savePackage: async (file) => {
      saved.push(file);
      return true;
    },
  });
  t.after(() => services.close());
  const bridge = createWorkbenchBridge(services.invoke, () => () => {});
  assert.equal((await bridge.devicePackagesState()).packages.length, 3);
  await assert.rejects(services.invoke('devicePackageExport', [{ id: f.id }]), /invalidParams/);
  const result = await bridge.devicePackageExport({ id: f.id, confirm: true });
  assert.equal(await bridge.devicePackageSave(result.id), true);
  assert.deepEqual(await services.packages.download(result.id), saved[0]);
  assert.equal(saved[0].name, result.name);
});

test('reviewed device ZIP imports into another host without execution and detects source changes', async (t) => {
  const f = await fixture(t);
  const archive = await f.packages.export({ id: f.id, confirm: true });
  const dataRoot = path.join(f.root, 'receiving-data');
  const manager = new RuntimePlugins({ roots: [path.join(dataRoot, 'plugins')], dataRoot });
  t.after(() => manager.close());
  const receiver = new DevicePackages({
    dataRoot,
    builtinRoot: '',
    plugins: () => manager.state(),
    reload: async () => {
      await manager.discover(true);
    },
  });
  const review = await receiver.review({ path: f.packages.download(archive.id).path });
  assert.equal(review.id, f.id);
  const installed = await receiver.install({
    ticket: review.ticket,
    fingerprint: review.fingerprint,
    confirm: true,
  });
  assert.ok(installed.packages.some((item) => item.id === f.id));
  assert.equal((await manager.state()).plugins.find((plugin) => plugin.id === f.id)?.trust, 'required');
  await assert.rejects(receiver.review({ path: f.directory }), /runtimePluginDuplicate/);
  const other = new DevicePackages({
    dataRoot: path.join(f.root, 'other-data'),
    builtinRoot: '',
    plugins: async () => ({ plugins: [], errors: [] }),
  });
  const changed = await other.review({ path: f.directory });
  await fs.appendFile(path.join(f.directory, 'runtime', 'index.mjs'), '// changed');
  await assert.rejects(
    other.install({ ticket: changed.ticket, fingerprint: changed.fingerprint, confirm: true }),
    /extensionChanged/,
  );
});
