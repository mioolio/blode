import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ToolVersions } from '../src/core/tool-versions';
import { OfflineTools } from '../src/core/tool-offline';
import { HardwareDebugger } from '../src/core/hardware-debugger';
import { runCommand } from '../src/core/process';
import { writeZip } from '../src/core/zip';
import { getBoardAdapter } from '../extensions/registry';
import {
  StlinkProgrammer,
  STLINK_WINDOWS_RELEASE,
} from '../extensions/boards/STM32F103C8T6/device/programmer';
import { createStm32Runtime } from '../extensions/boards/STM32F103C8T6/runtime/index';

const suffix = process.platform === 'win32' ? '.exe' : '';
const serial = '75010001230046504E413836';
const probe = `Found 1 stlink programmers\n1.\n  version: V2J27S6\n  serial: ${serial}\n  flash: 131072 (pagesize: 1024)\n  sram: 20480\n  chipid: 0x410\n  dev-type: STM32F1xx_MD\n`;

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-stlink-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools'),
    data = path.join(root, 'data');
  await fs.mkdir(tools);
  await fs.mkdir(data);
  const calls: { command: string; args: string[] }[] = [];
  const runner: typeof runCommand = async (command, args, options) => {
    calls.push({ command, args });
    if (/^tar(?:\.exe)?$/i.test(path.basename(command))) return runCommand(command, args, options);
    if (/icacls\.exe$/i.test(command)) return { code: 0, output: '' };
    return { code: 0, output: args.includes('--version') ? 'v1.9.0' : probe, stdout: probe };
  };
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  const options = { root: tools, dataRoot: data, config: () => config, runner, env: { PATH: '', Path: '' } };
  const install = async (directory: string) => {
    const bin = path.join(directory, 'bin');
    await fs.mkdir(bin, { recursive: true });
    for (const name of ['st-info', 'st-flash', 'st-util'])
      await fs.writeFile(path.join(bin, name + suffix), 'fixture');
    return bin;
  };
  return { root, tools, data, calls, config, options, install, runner };
}

test('ST-Link catalog recognizes managed, versioned and custom packages using the same binary pair', async (t) => {
  const f = await fixture(t);
  for (const directory of [
    path.join(f.tools, 'stlink'),
    path.join(f.tools, 'versions/stlink/1.9.0'),
    path.join(f.root, 'custom'),
  ]) {
    const bin = await f.install(directory);
    const custom = directory === path.join(f.root, 'custom');
    f.config.toolchain.stlinkDirectory = custom ? directory : '';
    const manager = new ToolVersions(f.options);
    const state = await manager.toolVersionsState();
    const entry = state.entries.find((entry) => entry.id === 'stlink:1.9.0')!;
    assert.equal(entry.installed, true);
    assert.equal(entry.installable, process.platform === 'win32' && process.arch === 'x64');
    if (entry.installable) assert.equal(entry.downloadUrl, STLINK_WINDOWS_RELEASE.downloadUrl);
    const selected = await manager.toolVersionSelect({ id: entry.id });
    assert.ok(selected.stlinkDirectory);
    assert.ok(state.localTools?.some((tool) => tool.kind === 'stlink' && tool.binaryDirectory === bin));
    const programmer = new StlinkProgrammer({ ...f.options, root: path.join(f.tools, 'stlink') });
    assert.equal((await programmer.status(custom ? bin : undefined)).installed, true);
    if (!custom) await fs.rm(directory, { recursive: true });
  }
  assert.ok(f.calls.every((call) => call.args.includes('--version')));
});

test('incomplete, mismatched and explicitly missing ST-Link installations stay unavailable', async (t) => {
  const f = await fixture(t),
    root = path.join(f.tools, 'stlink');
  await f.install(root);
  const options = { ...f.options, root };
  const programmer = new StlinkProgrammer({
    ...options,
    runner: async (command) => ({ code: 0, output: command.includes('st-flash') ? 'v1.8.0' : 'v1.9.0' }),
  });
  assert.equal((await programmer.status()).installed, false);
  const missing = path.join(f.root, 'missing');
  const strict = new StlinkProgrammer({
    ...options,
    runner: async (command, args, settings) =>
      command.startsWith(missing) ? { code: -1, output: '' } : f.runner(command, args, settings),
  });
  assert.equal((await strict.status(missing)).installed, false);
  await fs.unlink(path.join(root, 'bin', 'st-flash' + suffix));
  assert.equal(
    (await new ToolVersions(f.options).catalog()).find((entry) => entry.kind === 'stlink')?.installed,
    false,
  );
});

test('an older active installation cannot hide an installed catalog version', async (t) => {
  const f = await fixture(t);
  const older = path.join(f.tools, 'stlink');
  const current = path.join(f.tools, 'versions/stlink/1.9.0');
  await f.install(older);
  await f.install(current);
  const options = {
    ...f.options,
    runner: async (command: string) => ({ code: 0, output: command.startsWith(older) ? 'v1.8.0' : 'v1.9.0' }),
  };
  const state = await new ToolVersions(options).toolVersionsState();
  const entry = state.entries.find((entry) => entry.id === 'stlink:1.9.0')!;
  assert.equal(entry.installed, true);
  assert.equal(entry.directory, current);
  assert.deepEqual(
    state.localTools
      ?.filter((tool) => tool.kind === 'stlink')
      .map((tool) => tool.version)
      .sort(),
    ['1.8.0', '1.9.0'],
  );
});

test('STM32 detection and debugger use a side-by-side ST-Link import without a path override', async (t) => {
  const f = await fixture(t),
    directory = path.join(f.tools, 'versions/stlink/1.9.0');
  const bin = await f.install(directory);
  const runtime = createStm32Runtime({
    dataRoot: f.data,
    toolchainRoot: f.tools,
    env: f.options.env,
    runCommand: f.runner,
    emit() {},
  } as any);
  const devices = await runtime.discover(f.config);
  assert.equal(devices[0].serialNumber, serial);
  assert.equal(devices[0].debugProbe?.chipId, '0x410');
  assert.ok(
    f.calls.some(
      (call) => call.command === path.join(bin, 'st-info' + suffix) && call.args.includes('--probe'),
    ),
  );
  const debug = new HardwareDebugger(f.tools, f.data);
  assert.equal((await (debug as any).tools(f.config)).server, path.join(bin, 'st-util' + suffix));
  f.config.toolchain.stlinkDirectory = path.join(f.root, 'missing');
  assert.equal((await (debug as any).tools(f.config)).server, null);
});

test(
  'Windows ST-Link download ZIP installs offline and becomes discoverable immediately',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' },
  async (t) => {
    const f = await fixture(t),
      archive = path.join(f.root, 'publisher.zip');
    await writeZip(
      archive,
      (async function* () {
        for (const name of ['st-info.exe', 'st-flash.exe', 'st-util.exe', 'libstlink.dll'])
          yield { path: 'stlink/bin/' + name, data: Buffer.from('fixture') };
        yield { path: 'stlink/share/stlink/chips/F1.chip', data: Buffer.from('chip definitions') };
      })(),
    );
    const bytes = await fs.readFile(archive);
    const release = STLINK_WINDOWS_RELEASE;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url === release.metadataUrl)
        return Response.json({
          tag_name: release.version,
          assets: [
            {
              name: release.asset,
              browser_download_url: release.downloadUrl,
              digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
              size: bytes.length,
            },
          ],
        });
      assert.equal(url, release.downloadUrl);
      return new Response(bytes);
    };
    const download = new OfflineTools({ ...f.options, fetcher });
    const result = await download.download({ id: 'stlink:1.9.0', confirm: true });
    assert.equal(f.calls.length, 0);
    const receiver = new OfflineTools({
      ...f.options,
      fetcher: async () => {
        throw new Error('offline install contacted network');
      },
    });
    const state = await receiver.install({ path: download.downloadFile(result.id).path, confirm: true });
    assert.equal(state.entries.find((entry) => entry.id === 'stlink:1.9.0')?.installed, true);
    assert.equal(
      await fs.readFile(path.join(f.tools, 'versions/stlink/1.9.0/share/stlink/chips/F1.chip'), 'utf8'),
      'chip definitions',
    );
    const programmer = new StlinkProgrammer({ ...f.options, root: path.join(f.tools, 'stlink') });
    assert.equal((await programmer.status()).installed, true);
    assert.equal((await programmer.listProbes())[0].serialNumber, serial);
  },
);
