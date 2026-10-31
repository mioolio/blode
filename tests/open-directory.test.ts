import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openHostDirectory } from '../src/core/open-directory';
import { createHostServices } from '../src/core/host-services';
import { createWorkbenchBridge } from '../src/shared/workbench-bridge';
import { getBoardAdapter } from '../extensions/registry';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-open-directory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '中文目录 & $(not a command)');
  await fs.mkdir(directory);
  return { root, directory };
}

test('desktop folder opening uses the native shell and reports its returned failures', async (t) => {
  const { directory } = await fixture(t);
  const opened: string[] = [];
  await openHostDirectory(directory, {
    nativeOpenPath: async (value) => {
      opened.push(value);
      return '';
    },
    runner: async () => {
      throw Error('must not spawn Explorer');
    },
  });
  assert.deepEqual(opened, [directory]);
  await assert.rejects(
    openHostDirectory(directory, { nativeOpenPath: async () => 'Access denied' }),
    /openLocationFailed/,
  );
  await assert.rejects(
    openHostDirectory(path.join(directory, 'missing'), { nativeOpenPath: async () => '' }),
    /ENOENT/,
  );
});

test('Node Windows hosts hand folders to ShellExecute with literal Unicode paths and check helper failures', async (t) => {
  const { directory } = await fixture(t);
  await openHostDirectory(directory, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    runner: async (file, args, options) => {
      assert.match(file, /powershell\.exe$/i);
      assert.ok(args.some((arg) => arg.includes('UseShellExecute=$true')));
      assert.ok(!args.some((arg) => arg.includes(directory)));
      assert.equal(options?.env?.BLODE_DIRECTORY_TO_OPEN, directory);
      assert.ok(!args.includes('explorer.exe'));
      return { code: 0, output: '' };
    },
  });
  await assert.rejects(
    openHostDirectory(directory, {
      platform: 'linux',
      runner: async (file, args) => {
        assert.equal(file, 'xdg-open');
        assert.deepEqual(args, [directory]);
        return { code: 1, output: 'no desktop session' };
      },
    }),
    /openLocationFailed/,
  );
});

test('the shared host route opens only the selected registered module through the desktop callback', async (t) => {
  const { root } = await fixture(t);
  const builtinRoot = path.join(root, 'device-modules');
  await fs.mkdir(path.join(builtinRoot, 'STM32F103C8T6_Module'), { recursive: true });
  const opened: string[] = [];
  const services = createHostServices({
    core: {
      currentProjectRoot: () => '',
      currentConfig: () => getBoardAdapter('auto').createConfig(),
      runtimePlugins: { state: async () => ({ plugins: [], errors: [] }) },
    } as any,
    collaboration: {} as any,
    firmware: {} as any,
    recent: {} as any,
    dataRoot: path.join(root, 'data'),
    toolchainRoot: path.join(root, 'tools'),
    builtinDevicePackagesRoot: builtinRoot,
    directoryOpener: {
      nativeOpenPath: async (directory) => {
        opened.push(directory);
        return '';
      },
    },
    emit() {},
  });
  t.after(() => services.close());
  const bridge = createWorkbenchBridge(services.invoke, () => () => {});
  await bridge.devicePackageOpenLocation('STM32F103C8T6');
  assert.deepEqual(opened, [path.join(builtinRoot, 'STM32F103C8T6_Module')]);
  await assert.rejects(bridge.devicePackageOpenLocation('../unregistered'), /devicePackageUnknown/);
  assert.equal(opened.length, 1);
});
