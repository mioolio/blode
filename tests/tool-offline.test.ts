import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { OfflineTools } from '../src/core/tool-offline';
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
      return command === 'tar'
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
