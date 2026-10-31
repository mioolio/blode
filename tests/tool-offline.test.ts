import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { OfflineTools } from '../src/core/tool-offline';
import { BundledArchiveWriter } from '../src/core/archive-writer';
import { createDeliveryRoutes } from '../src/core/delivery-routes';
import { InstallationTracker } from '../src/core/installation';
import { ToolVersions, arduinoCliAsset } from '../src/core/tool-versions';
import { getBoardAdapter } from '../extensions/registry';
import { runCommand } from '../src/core/process';
import { writeZip } from '../src/core/zip';
import { readComponentZip } from '../src/core/component-zip';
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-tool-offline-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const tools = path.join(root, 'tools'),
    data = path.join(root, 'data');
  await fs.mkdir(tools);
  await fs.mkdir(data);
  const filename = 'arduino-cli' + (process.platform === 'win32' ? '.exe' : '');
  const archive = path.join(root, 'publisher.zip');
  await writeZip(
    archive,
    (async function* () {
      yield { path: filename, data: Buffer.from('fixture binary') };
    })(),
  );
  const bytes = await fs.readFile(archive),
    release = arduinoCliAsset('1.3.1', process.platform, process.arch)!;
  let network = 0,
    commands = 0;
  const fetcher: typeof fetch = async (input) => {
    network++;
    const url = String(input);
    if (url === release.metadataUrl)
      return Response.json({
        tag_name: 'v1.3.1',
        assets: [
          {
            name: release.asset,
            browser_download_url: release.downloadUrl,
            size: bytes.length,
            digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      });
    assert.equal(url, release.downloadUrl);
    return new Response(bytes);
  };
  const options = {
    root: tools,
    dataRoot: data,
    config: () => getBoardAdapter('STM32F103C8T6').createConfig(),
    fetcher,
    runner: async (command: string, args: string[], settings: any = {}) => {
      commands++;
      return /^tar(?:\.exe)?$/i.test(path.basename(command))
        ? runCommand(command, args, settings)
        : {
            code: 0,
            output: command.includes('arduino-cli') ? 'arduino-cli Version: 1.3.1' : '',
            stdout: '',
          };
    },
  };
  return { root, tools, data, options, network: () => network, commands: () => commands };
}
async function rewrite(source: string, target: string, edit: (files: Map<string, Buffer>) => void) {
  const files = readComponentZip(await fs.readFile(source));
  edit(files);
  await writeZip(
    target,
    (async function* () {
      for (const [path, data] of files) yield { path, data };
    })(),
  );
}
test('download only produces a verified shareable ZIP; offline import installs without network', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip('catalog supports Windows/Linux');
  const f = await fixture(t),
    manager = new OfflineTools(f.options),
    result = await manager.download({ id: 'arduino-cli:1.3.1', confirm: true });
  assert.equal(f.commands(), 0);
  assert.equal(
    (await new ToolVersions(f.options).catalog()).find((item) => item.id === result.toolId)!.installed,
    false,
  );
  const file = manager.downloadFile(result.id).path;
  assert.equal((await new ToolVersions(f.options).toolVersionsState()).archives?.[0].sha256, result.sha256);
  const before = f.network();
  const installed = await new OfflineTools({
    ...f.options,
    fetcher: async () => {
      assert.fail('offline import must never fetch');
    },
  }).install({ path: file, confirm: true });
  assert.equal(f.network(), before);
  assert.equal(installed.entries.find((item) => item.id === result.toolId)!.installed, true);
  assert.equal(
    await fs.readFile(
      path.join(
        f.tools,
        'versions',
        'arduino-cli',
        '1.3.1',
        'bin',
        'arduino-cli' + (process.platform === 'win32' ? '.exe' : ''),
      ),
      'utf8',
    ),
    'fixture binary',
  );
});
test('platform mismatch and damaged payload fail before installing any tool', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t),
    manager = new OfflineTools(f.options),
    result = await manager.download({ id: 'arduino-cli:1.3.1', confirm: true }),
    source = manager.downloadFile(result.id).path;
  const mismatch = path.join(f.root, 'mismatch.zip');
  await rewrite(source, mismatch, (files) => {
    const json = JSON.parse(files.get('blode-tool-package.json')!.toString());
    json.arch = 'different';
    files.set('blode-tool-package.json', Buffer.from(JSON.stringify(json)));
  });
  await assert.rejects(() => manager.install({ path: mismatch, confirm: true }), /toolPackagePlatform/);
  const damaged = path.join(f.root, 'damaged.zip');
  await rewrite(source, damaged, (files) => {
    const key = [...files.keys()].find((key) => /publisher|Windows|Linux/.test(key))!;
    files.set(key, Buffer.from('tampered'));
  });
  await assert.rejects(() => manager.install({ path: damaged, confirm: true }), /toolPackageChecksum/);
  assert.equal(
    (await new ToolVersions(f.options).catalog()).find((item) => item.id === result.toolId)!.installed,
    false,
  );
});
test('archive traversal is rejected without creating outside files', async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, 'traversal.zip');
  await writeZip(
    file,
    (async function* () {
      yield { path: 'safe/file.txt', data: Buffer.from('bad') };
    })(),
  );
  const bytes = await fs.readFile(file);
  for (let index = 0; (index = bytes.indexOf(Buffer.from('safe/'), index)) >= 0; index += 5)
    bytes.write('../x/', index, 'utf8');
  await fs.writeFile(file, bytes);
  await assert.rejects(
    () => new OfflineTools(f.options).install({ path: file, confirm: true }),
    /toolPackageExtract/,
  );
  assert.equal(await fs.stat(path.join(f.tools, 'offline-imports', 'x', 'file.txt')).catch(() => null), null);
});
test('cancelling download removes partial files and cannot mark a tool installed', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t),
    controller = new AbortController();
  const manager = new OfflineTools({
    ...f.options,
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.phase === 'downloading' && progress.receivedBytes)
        controller.abort(new Error('cancelled-download'));
    },
  });
  await assert.rejects(
    () => manager.download({ id: 'arduino-cli:1.3.1', confirm: true }),
    /cancelled-download/,
  );
  assert.deepEqual(
    (await fs.readdir(path.join(f.data, 'exports'))).filter((name) => /\.zip$|tool-download-/.test(name)),
    [],
  );
});

test('ESP32 offline packages include every host tool and retain paths after atomic installation', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t),
    coreZip = path.join(f.root, 'core.zip'),
    compilerZip = path.join(f.root, 'compiler.zip');
  await writeZip(
    coreZip,
    (async function* () {
      yield { path: 'esp32/platform.txt', data: Buffer.from('name=ESP32 fixture\n') };
      yield { path: 'esp32/boards.txt', data: Buffer.from('esp32s3.name=ESP32 S3\n') };
    })(),
  );
  await writeZip(
    compilerZip,
    (async function* () {
      yield { path: 'compiler/bin/xtensa-esp32s3-elf-gcc', data: Buffer.from('fixture compiler') };
    })(),
  );
  const core = await fs.readFile(coreZip),
    compiler = await fs.readFile(compilerZip);
  const info = (bytes: Buffer, url: string, name: string) => ({
    url,
    archiveFileName: name,
    size: String(bytes.length),
    checksum: 'SHA-256:' + createHash('sha256').update(bytes).digest('hex'),
  });
  const host =
    process.platform === 'win32'
      ? 'i686-mingw32'
      : process.arch === 'arm64'
        ? 'aarch64-linux-gnu'
        : 'x86_64-pc-linux-gnu';
  const index = {
    packages: [
      {
        name: 'esp32',
        platforms: [
          {
            architecture: 'esp32',
            version: '3.0.7',
            ...info(core, 'https://example.test/core.zip', 'core.zip'),
            toolsDependencies: [{ packager: 'esp32', name: 'esp-xs3', version: '2302' }],
          },
        ],
        tools: [
          {
            name: 'esp-xs3',
            version: '2302',
            systems: [{ host, ...info(compiler, 'https://example.test/compiler.zip', 'compiler.zip') }],
          },
        ],
      },
    ],
  };
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    return url.includes('package_esp32_index.json')
      ? Response.json(index)
      : url.includes('package_index.json')
        ? Response.json({ packages: [] })
        : new Response(url.includes('core.zip') ? core : compiler);
  };
  const manager = new OfflineTools({ ...f.options, fetcher }),
    downloaded = await manager.download({ id: 'arduino-esp32:3.0.7', confirm: true });
  const source = manager.downloadFile(downloaded.id).path,
    missing = path.join(f.root, 'missing-compiler.zip');
  await rewrite(source, missing, (files) => {
    const manifest = JSON.parse(files.get('blode-tool-package.json')!.toString());
    for (const item of manifest.files) if (item.url.includes('compiler.zip')) files.delete(item.path);
    manifest.files = manifest.files.filter((item: any) => !item.url.includes('compiler.zip'));
    files.set('blode-tool-package.json', Buffer.from(JSON.stringify(manifest)));
  });
  await assert.rejects(() => manager.install({ path: missing, confirm: true }), /toolPackageIncomplete/);
  const installed = await new OfflineTools({
    ...f.options,
    fetcher: async () => {
      assert.fail('offline install may not fetch');
    },
  }).install({ path: source, confirm: true });
  assert.equal(installed.entries.find((item) => item.id === downloaded.toolId)?.installed, true);
  const directory = path.join(f.tools, 'versions', 'arduino-esp32', '3.0.7');
  const config = JSON.parse(await fs.readFile(path.join(directory, 'arduino-cli.yaml'), 'utf8'));
  assert.equal(config.directories.data, path.join(directory, 'arduino-data'));
  assert.ok(
    (
      await fs.stat(
        path.join(
          directory,
          'arduino-data',
          'packages',
          'esp32',
          'tools',
          'esp-xs3',
          '2302',
          'bin',
          'xtensa-esp32s3-elf-gcc',
        ),
      )
    ).isFile(),
  );
});

test('failed promotion restores an existing partial tool version and leaves no import staging files', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t),
    manager = new OfflineTools(f.options),
    downloaded = await manager.download({ id: 'arduino-cli:1.3.1', confirm: true }),
    source = manager.downloadFile(downloaded.id).path;
  const destination = path.join(f.tools, 'versions', 'arduino-cli', '1.3.1');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'user-note.txt'), 'keep this partial installation');
  const rename = fs.rename.bind(fs);
  let failed = false;
  t.mock.method(
    fs,
    'rename',
    async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (
        String(to) === destination &&
        String(from).includes('offline-imports') &&
        !String(from).endsWith('previous')
      ) {
        failed = true;
        throw new Error('fixture promotion failed');
      }
      return rename(from, to);
    },
  );
  await assert.rejects(() => manager.install({ path: source, confirm: true }), /fixture promotion failed/);
  assert.equal(failed, true);
  assert.equal(
    await fs.readFile(path.join(destination, 'user-note.txt'), 'utf8'),
    'keep this partial installation',
  );
  assert.equal(await fs.stat(path.join(destination, 'bin')).catch(() => null), null);
  assert.deepEqual(await fs.readdir(path.join(f.tools, 'offline-imports')), []);
});

test('installed toolchains export as ZIP and install offline on a clean client', async (t) => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return t.skip();
  const f = await fixture(t),
    version = '15.2.1-1.1',
    bin = path.join(f.tools, 'versions', 'gnu-arm', version, 'bin'),
    suffix = process.platform === 'win32' ? '.exe' : '';
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'arm-none-eabi-gcc' + suffix), 'fixture gcc');
  await fs.writeFile(path.join(bin, 'arm-none-eabi-objcopy' + suffix), 'fixture objcopy');
  const exporter = new OfflineTools(f.options),
    result = await exporter.exportInstalled({ id: `gnu-arm:${version}`, confirm: true });
  assert.equal(result.toolId, `gnu-arm:${version}`);
  assert.equal(f.network(), 0);
  const state = await new ToolVersions(f.options).toolVersionsState();
  assert.ok(state.localTools?.some((item) => item.id === `gnu-arm:${version}` && item.exportable));
  assert.equal(state.archives?.find((item) => item.id === result.id)?.sha256, result.sha256);
  const clientTools = path.join(f.root, 'client-tools'),
    clientData = path.join(f.root, 'client-data');
  await fs.mkdir(clientTools);
  await fs.mkdir(clientData);
  const imported = await new OfflineTools({
    ...f.options,
    root: clientTools,
    dataRoot: clientData,
    fetcher: async () => {
      assert.fail('offline import must never fetch');
    },
  }).install({ path: exporter.downloadFile(result.id).path, confirm: true });
  assert.equal(imported.entries.find((item) => item.id === result.toolId)?.installed, true);
  assert.equal(
    await fs.readFile(
      path.join(clientTools, 'versions', 'gnu-arm', version, 'bin', 'arm-none-eabi-gcc' + suffix),
      'utf8',
    ),
    'fixture gcc',
  );
});

test('installed Arduino versions export separately and rebase paths during offline import', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t);
  const version = '2.0.17';
  const cli = path.join(f.tools, 'versions', 'arduino-cli', '1.2.2', 'bin');
  const esp = path.join(f.tools, 'versions', 'arduino-esp32', version);
  await fs.mkdir(cli, { recursive: true });
  await fs.writeFile(
    path.join(cli, 'arduino-cli' + (process.platform === 'win32' ? '.exe' : '')),
    'fixture cli',
  );
  const platform = path.join(esp, 'arduino-data', 'packages', 'esp32', 'hardware', 'esp32', version);
  await fs.mkdir(platform, { recursive: true });
  await fs.writeFile(path.join(platform, 'platform.txt'), 'name=ESP32 fixture');
  await fs.writeFile(
    path.join(esp, 'arduino-cli.yaml'),
    JSON.stringify({ network: { proxy: 'PRIVATE-CREDENTIAL' } }),
  );
  await fs.writeFile(path.join(esp, 'installed.json'), JSON.stringify({ version }));
  await fs.writeFile(path.join(esp, '.env'), 'PRIVATE-CREDENTIAL');
  const exporter = new OfflineTools(f.options);
  const state = await new ToolVersions(f.options).toolVersionsState();
  assert.ok(state.localTools?.some((item) => item.id === 'arduino-esp32:2.0.17'));
  assert.ok(!state.localTools?.some((item) => item.id === 'arduino-esp32:3.0.7'));
  const result = await exporter.exportInstalled({ id: 'arduino-esp32:' + version, confirm: true });
  const bytes = readComponentZip(await fs.readFile(exporter.downloadFile(result.id).path));
  assert.ok(!bytes.has('files/.env'));
  assert.ok(!bytes.get('files/arduino-cli.yaml')!.toString().includes('PRIVATE-CREDENTIAL'));
  const root = path.join(f.root, 'clean-tools'),
    dataRoot = path.join(f.root, 'clean-data');
  await fs.mkdir(root);
  await fs.mkdir(dataRoot);
  await new OfflineTools({
    ...f.options,
    root,
    dataRoot,
    fetcher: async () => assert.fail('no network'),
  }).install({ path: exporter.downloadFile(result.id).path, confirm: true });
  const imported = JSON.parse(
    await fs.readFile(path.join(root, 'versions', 'arduino-esp32', version, 'arduino-cli.yaml'), 'utf8'),
  );
  assert.equal(
    imported.directories.data,
    path.join(root, 'versions', 'arduino-esp32', version, 'arduino-data'),
  );
  assert.equal(f.network(), 0);
});

test('managed GNU is listed and exportable without a matching download catalog version', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t);
  const bin = path.join(f.tools, 'armgcc', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
    await fs.writeFile(path.join(bin, name + suffix), 'fixture compiler');
  const options = {
    ...f.options,
    env: { PATH: '', Path: '' },
    runner: async (cmd: string, args: string[], opts: any = {}) =>
      cmd.includes('arm-none-eabi-gcc')
        ? { code: 0, output: 'arm-none-eabi-gcc 12.3.1' }
        : f.options.runner(cmd, args, opts),
  };
  const state = await new ToolVersions(options).toolVersionsState();
  const tool = state.localTools!.find((item) => item.kind === 'gnu-arm')!;
  assert.equal(tool.version, '12.3.1');
  assert.equal(tool.exportable, true);
  const exporter = new OfflineTools(options);
  const result = await exporter.exportInstalled({ id: tool.id, confirm: true });
  const root = path.join(f.root, 'imported-tools'),
    dataRoot = path.join(f.root, 'imported-data');
  await fs.mkdir(root);
  await fs.mkdir(dataRoot);
  await new OfflineTools({ ...options, root, dataRoot }).install({
    path: exporter.downloadFile(result.id).path,
    confirm: true,
  });
  assert.equal(
    await fs.readFile(
      path.join(root, 'versions', 'gnu-arm', '12.3.1', 'bin', 'arm-none-eabi-gcc' + suffix),
      'utf8',
    ),
    'fixture compiler',
  );
});

test('symbolic links in a publisher archive are rejected before installation', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t);
  const header = Buffer.alloc(512);
  header.write('arduino-cli', 0);
  header.write('0000777\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('00000000000\0', 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write('2', 156);
  header.write('../../outside', 157);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  const tar = Buffer.concat([header, Buffer.alloc(1024)]),
    release = arduinoCliAsset('1.3.1', process.platform, process.arch)!;
  const fetcher: typeof fetch = async (input) =>
    String(input) === release.metadataUrl
      ? Response.json({
          tag_name: 'v1.3.1',
          assets: [
            {
              name: release.asset,
              browser_download_url: release.downloadUrl,
              size: tar.length,
              digest: 'sha256:' + createHash('sha256').update(tar).digest('hex'),
            },
          ],
        })
      : new Response(tar);
  const manager = new OfflineTools({ ...f.options, fetcher }),
    downloaded = await manager.download({ id: 'arduino-cli:1.3.1', confirm: true });
  await assert.rejects(
    () => manager.install({ path: manager.downloadFile(downloaded.id).path, confirm: true }),
    /toolPackageExtract/,
  );
  assert.equal(
    (await new ToolVersions(f.options).catalog()).find((item) => item.id === downloaded.toolId)?.installed,
    false,
  );
  assert.equal(await fs.stat(path.join(f.root, 'outside')).catch(() => null), null);
});

test('custom Arm Compiler and ST-Link export/import with dependencies and exclude unrelated host files', async (t) => {
  if (!['win32', 'linux'].includes(process.platform)) return t.skip();
  const f = await fixture(t);
  const arm = path.join(f.root, 'external-arm', 'bin'),
    stlink = path.join(f.root, 'external-stlink', 'bin');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const directory of [arm, stlink]) await fs.mkdir(directory, { recursive: true });
  for (const name of ['armclang', 'armlink', 'fromelf'])
    await fs.writeFile(path.join(arm, name + suffix), 'arm fixture');
  for (const name of ['st-info', 'st-util', 'st-flash'])
    await fs.writeFile(path.join(stlink, name + suffix), 'stlink fixture');
  await fs.writeFile(path.join(arm, 'runtime.dll'), 'required DLL');
  await fs.writeFile(path.join(stlink, 'libusb.dll'), 'USB DLL');
  await fs.writeFile(path.join(arm, 'unrelated.txt'), 'do not export');
  await fs.writeFile(path.join(arm, 'private.key'), 'do not export');
  await fs.mkdir(path.join(path.dirname(arm), 'lib'), { recursive: true });
  await fs.writeFile(path.join(path.dirname(arm), 'lib', 'runtime.a'), 'required library');
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  config.toolchain.armCompilerDirectory = arm;
  config.toolchain.stlinkDirectory = stlink;
  const options = {
    ...f.options,
    archiver: new BundledArchiveWriter({ root: path.resolve('vendor/7zip'), dataRoot: f.data }),
    config: () => config,
    env: { PATH: '', Path: '' },
    runner: async (cmd: string, args: string[], opts: any = {}) =>
      cmd.includes('armclang')
        ? { code: 0, output: 'Arm Compiler 6.22' }
        : /st-(?:info|flash)/.test(cmd)
          ? { code: 0, output: 'st-info 1.9.0' }
          : f.options.runner(cmd, args, opts),
  };
  const state = await new ToolVersions(options).toolVersionsState();
  const root = path.join(f.root, 'client'),
    dataRoot = path.join(f.root, 'client-data');
  await fs.mkdir(root);
  await fs.mkdir(dataRoot);
  const exporter = new OfflineTools(options),
    receiver = new OfflineTools({
      ...options,
      root,
      dataRoot,
      config: () => getBoardAdapter('auto').createConfig(),
    });
  for (const kind of ['armclang', 'stlink']) {
    const tool = state.localTools!.find((tool) => tool.kind === kind)!;
    assert.equal(tool.exportable, true);
    const result = await exporter.exportInstalled({ id: tool.id, confirm: true });
    const files = readComponentZip(await fs.readFile(exporter.downloadFile(result.id).path));
    assert.ok(!files.has('files/bin/unrelated.txt'));
    assert.ok(!files.has('files/bin/private.key'));
    assert.ok(files.has('files/bin/' + (kind === 'armclang' ? 'runtime.dll' : 'libusb.dll')));
    await receiver.install({ path: exporter.downloadFile(result.id).path, confirm: true });
    const directory = path.join(root, 'versions', kind, tool.version, 'bin');
    assert.equal(
      await fs.readFile(
        path.join(directory, (kind === 'armclang' ? 'armclang' : 'st-info') + suffix),
        'utf8',
      ),
      kind === 'armclang' ? 'arm fixture' : 'stlink fixture',
    );
  }
  const local = (
    await new ToolVersions({
      ...options,
      root,
      dataRoot,
      config: () => getBoardAdapter('auto').createConfig(),
    }).toolVersionsState()
  ).localTools!;
  assert.ok(local.some((tool) => tool.kind === 'armclang' && tool.exportable));
  assert.ok(local.some((tool) => tool.kind === 'stlink' && tool.exportable));
});

test('tool export delivery announces export before work starts', async (t) => {
  const f = await fixture(t),
    version = '13.3.1-1.1';
  const bin = path.join(f.tools, 'versions', 'gnu-arm', version, 'bin');
  await fs.mkdir(bin, { recursive: true });
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
    await fs.writeFile(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), 'fixture');
  const events: any[] = [],
    tracker = new InstallationTracker((event) => events.push(event));
  const delivery = createDeliveryRoutes({
    dataRoot: f.data,
    projectRoot: () => '',
    toolOptions: f.options,
    runInstallation: async (tool, action, operation) => {
      await tracker.run(
        tool,
        () => action({ progress: tracker.progress, log() {}, signal: new AbortController().signal }),
        operation,
      );
    },
  });
  await delivery.routes.toolVersionExport.run({ id: 'gnu-arm:' + version, confirm: true });
  assert.equal(events[0].message, 'status.exportStarting');
  assert.equal(events[0].installation.operation, 'export');
  assert.ok(!events.some((event) => event.message.startsWith('status.install')));
});

test('each tool export rescans changed, added and removed files and reports fresh archive details', async (t) => {
  const f = await fixture(t),
    version = '13.3.1-1.1';
  const root = path.join(f.tools, 'versions', 'gnu-arm', version);
  const bin = path.join(root, 'bin'),
    include = path.join(root, 'arm-none-eabi', 'include');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(include, { recursive: true });
  for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
    await fs.writeFile(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), 'fixture');
  await fs.writeFile(path.join(include, 'config.h'), 'before');
  await fs.writeFile(path.join(include, 'removed.h'), 'removed');
  const logs: string[] = [];
  const delivery = createDeliveryRoutes({
    dataRoot: f.data,
    projectRoot: () => '',
    toolOptions: {
      ...f.options,
      archiver: new BundledArchiveWriter({ root: path.resolve('vendor/7zip'), dataRoot: f.data }),
    },
    runInstallation: async (tool, action, operation) => {
      const tracker = new InstallationTracker(() => {});
      await tracker.run(
        tool,
        () =>
          action({
            progress: tracker.progress,
            log: (line) => {
              logs.push(line);
            },
            signal: new AbortController().signal,
          }),
        operation,
      );
    },
  });
  const first = await delivery.routes.toolVersionExport.run({ id: 'gnu-arm:' + version, confirm: true });
  const firstFile = await delivery.download(first.id);
  const firstBytes = await fs.readFile(firstFile.path);
  const old = readComponentZip(firstBytes);
  assert.equal(old.get('files/arm-none-eabi/include/config.h')?.toString(), 'before');
  assert.ok(old.has('files/arm-none-eabi/include/removed.h'));

  // Same length and timestamp: a previous manifest must never stand in for fresh hashing.
  const stamp = await fs.stat(path.join(include, 'config.h'));
  await fs.writeFile(path.join(include, 'config.h'), 'after!');
  await fs.utimes(path.join(include, 'config.h'), stamp.atime, stamp.mtime);
  await fs.unlink(path.join(include, 'removed.h'));
  await fs.writeFile(path.join(include, 'added.h'), 'new header');
  logs.length = 0;
  const second = await delivery.routes.toolVersionExport.run({ id: 'gnu-arm:' + version, confirm: true });
  const fresh = readComponentZip(await fs.readFile((await delivery.download(second.id)).path));
  const manifest = JSON.parse(fresh.get('blode-tool-snapshot.json')!.toString());
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(fresh.get('files/arm-none-eabi/include/config.h')?.toString(), 'after!');
  assert.equal(fresh.get('files/arm-none-eabi/include/added.h')?.toString(), 'new header');
  assert.ok(!fresh.has('files/arm-none-eabi/include/removed.h'));
  assert.equal(
    manifest.files.find((file: { path: string }) => file.path.endsWith('/config.h')).sha256,
    createHash('sha256').update('after!').digest('hex'),
  );
  assert.ok(!manifest.files.some((file: { path: string }) => file.path.endsWith('/removed.h')));
  assert.deepEqual(await fs.readFile(firstFile.path), firstBytes);
  assert.equal(logs[0], 'status.exportRefreshInventory');
  for (const key of [
    'exportTool',
    'exportSourceDirectory',
    'exportPlatform',
    'exportScanDirectory',
    'exportCurrentFile',
    'exportManifestFiles',
    'exportManifestSize',
    'exportManifestWritten',
    'exportCompressionProgress',
    'exportArchiveSize',
    'exportChecksum',
    'exportArchiveName',
    'exportElapsed',
  ])
    assert.ok(
      logs.some((line) => line.startsWith('status.' + key + ': ')),
      key,
    );
  assert.ok(logs.includes('status.exportChecksum: ' + second.sha256));
  assert.ok(logs.includes('status.exportManifestFiles: ' + manifest.files.length));
  assert.ok(
    logs.some((line) => line.startsWith('status.archiveEngine: ') || line === 'status.archiveFallback'),
  );
});
