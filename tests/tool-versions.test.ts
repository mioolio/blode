import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ToolVersions, arduinoCliAsset } from '../src/core/tool-versions';
import { GnuArmToolchain, gnuRelease } from '../extensions/boards/STM32F103C8T6/tools/gnu';
import { Toolchains } from '../extensions/boards/Esp32_S3_CAM/tools/toolchain';
import { getBoardAdapter } from '../extensions/registry';

test('version catalog resolves real Windows and Linux architecture asset names', () => {
  assert.match(gnuRelease('14.2.1-1.1', 'linux', 'arm64').downloadUrl, /14\.2\.1-1\.1-linux-arm64\.tar\.gz$/);
  assert.match(gnuRelease('13.3.1-1.1', 'win32', 'x64').downloadUrl, /win32-x64\.zip$/);
  assert.match(arduinoCliAsset('1.3.1', 'linux', 'arm64')!.asset, /Linux_ARM64\.tar\.gz$/);
  assert.equal(arduinoCliAsset('1.2.2', 'darwin', 'arm64'), null);
  assert.throws(() => gnuRelease('999.1', 'win32', 'x64'), /gnuRelease/);
});

test('installed GNU versions are selected by explicit project path without deleting other versions', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-tool-versions-'));
  try {
    for (const version of ['13.3.1-1.1', '14.2.1-1.1']) {
      const bin = path.join(root, 'versions', 'gnu-arm', version, 'bin');
      await fs.mkdir(bin, { recursive: true });
      for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
        await fs.writeFile(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), 'fixture');
    }
    const manager = new ToolVersions({
      root,
      dataRoot: root,
      config: () => getBoardAdapter('STM32F103C8T6').createConfig(),
      runner: async () => ({ code: 0, output: '' }),
    });
    const patch = await manager.toolVersionSelect({ id: 'gnu-arm:13.3.1-1.1' });
    assert.equal(patch.armCompilerDirectory, path.join(root, 'versions', 'gnu-arm', '13.3.1-1.1', 'bin'));
    assert.ok(
      (await manager.toolVersionsState()).entries.find((item) => item.id === 'gnu-arm:14.2.1-1.1')?.installed,
    );
    await assert.rejects(() =>
      manager.toolVersionInstall({ id: 'gnu-arm:13.3.1-1.1', confirm: false } as any),
    );
    await assert.rejects(() => manager.toolVersionSelect({ id: 'gnu-arm:15.2.1-1.1' }), /NotInstalled/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('older GNU releases verify the publisher checksum sidecar before installing', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-gnu-sidecar-'));
  const expected = gnuRelease('14.2.1-1.1');
  const bytes = Buffer.from('tiny verified archive fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === expected.metadataUrl)
      return Response.json({
        tag_name: expected.version,
        assets: [
          { name: expected.asset, browser_download_url: expected.downloadUrl, size: bytes.length },
          { name: expected.asset + '.sha', browser_download_url: expected.downloadUrl + '.sha' },
        ],
      });
    if (url.endsWith('.sha')) return new Response(`${digest}  ${expected.asset}\n`);
    return new Response(bytes);
  };
  const runner = async (command: string, args: string[]) => {
    if (command === 'tar' && args[0] === '-tf')
      return { code: 0, output: 'distribution/bin/arm-none-eabi-gcc\n' };
    if (command === 'tar' && args[0] === '-xf') {
      const bin = path.join(args[args.indexOf('-C') + 1], 'distribution', 'bin');
      await fs.mkdir(bin, { recursive: true });
      for (const name of ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'])
        await fs.writeFile(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), 'fixture');
      return { code: 0, output: '' };
    }
    return { code: 0, output: 'arm-none-eabi-gcc 14.2.1' };
  };
  try {
    await new GnuArmToolchain({ root, release: expected, fetcher, runner }).install();
    assert.ok(calls.includes(expected.downloadUrl + '.sha'));
    assert.ok(
      await fs.stat(
        path.join(root, 'bin', 'arm-none-eabi-gcc' + (process.platform === 'win32' ? '.exe' : '')),
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unverified GNU metadata cannot reach extraction', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-gnu-invalid-'));
  let commands = 0;
  const expected = gnuRelease();
  try {
    await assert.rejects(
      () =>
        new GnuArmToolchain({
          root,
          fetcher: async () =>
            Response.json({
              tag_name: expected.version,
              assets: [{ name: expected.asset, browser_download_url: expected.downloadUrl }],
            }),
          runner: async () => {
            commands++;
            return { code: 0, output: '' };
          },
        }).install(),
      /gnuChecksum/,
    );
    assert.equal(commands, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ESP32 core versions use isolated stores and an exact install target', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blode-esp-versions-'));
  const calls: string[][] = [];
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    return {
      code: 0,
      output: args.includes('list')
        ? JSON.stringify({ platforms: [{ id: 'esp32:esp32', installed_version: '2.0.17' }] })
        : '',
    };
  };
  const manager = new ToolVersions({ root, dataRoot: root, config: () => config, runner });
  try {
    const state = await manager.toolVersionInstall({ id: 'arduino-esp32:2.0.17', confirm: true });
    assert.ok(state.entries.find((item) => item.id === 'arduino-esp32:2.0.17')?.installed);
    assert.ok(calls.some((args) => args.includes('esp32:esp32@2.0.17')));
    const patch = await manager.toolVersionSelect({ id: 'arduino-esp32:2.0.17' });
    assert.equal(patch.packageDirectory, path.join(root, 'versions', 'arduino-esp32', '2.0.17'));
    const cli = new Toolchains(runner, root, () => {}, {}, root);
    await cli.runCli({ ...config, toolchain: { ...config.toolchain, ...patch } }, ['version']);
    const yaml = JSON.parse(
      await fs.readFile(path.join(patch.packageDirectory!, 'arduino-cli.yaml'), 'utf8'),
    );
    assert.equal(yaml.directories.data, path.join(patch.packageDirectory!, 'arduino-data'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
