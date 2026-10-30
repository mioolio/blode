import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url),
  {
    matchesTarget,
    probeNativeRuntime,
    beforeBuild,
    prepareRuntimeStage,
  } = require('../scripts/native-runtime.cjs');
const electronVersion = require('electron/package.json').version;
const context = {
  appDir: process.cwd(),
  electronVersion,
  platform: { nodeName: process.platform },
  arch: process.arch,
};

test('native reuse is limited to exact host architecture, platform and installed Electron version', () => {
  assert.equal(matchesTarget(context, electronVersion), true);
  for (const value of [
    { ...context, arch: 'different' },
    { ...context, platform: { nodeName: 'different' } },
    { ...context, electronVersion: '0.0.0' },
  ])
    assert.equal(matchesTarget(value, electronVersion), false);
  assert.equal(matchesTarget({ ...context, platform: process.platform }, electronVersion), true);
});

test('cross-target and failed native checks preserve the normal electron-builder rebuild', async (t) => {
  let started = 0;
  const mismatch = await probeNativeRuntime(
    { ...context, arch: 'different' },
    {
      spawnProcess() {
        started++;
        throw Error('must not start');
      },
    },
  );
  assert.equal(mismatch.ok, false);
  assert.equal(started, 0);
  const failed = await probeNativeRuntime(context, {
    spawnProcess() {
      started++;
      throw Error('fixture start failure');
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'probe-start');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-native-build-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(await beforeBuild({ ...context, appDir: root, electronVersion: '0.0.0' }), true);
});

test('a zero-exit process cannot pass without matching native and UTF8 probe evidence', async () => {
  const fake = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.write(
        'BLODE_NATIVE_PROBE:' +
          JSON.stringify({
            ok: true,
            electron: 'wrong',
            platform: process.platform,
            arch: process.arch,
            serialport: true,
            pty: true,
            utf8: true,
          }) +
          '\n',
      );
      child.emit('close', 0);
    });
    return child;
  };
  assert.equal((await probeNativeRuntime(context, { spawnProcess: fake })).ok, false);
});

test(
  'installed native bindings load and run a private UTF8 PTY in the actual target Electron',
  { timeout: 30000 },
  async () => {
    const result = await probeNativeRuntime(context);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.electron, electronVersion);
    assert.equal(result.serialport, true);
    assert.equal(result.pty, true);
    assert.equal(result.utf8, true);
  },
);

test('verified production staging resolves nested versions and excludes developer credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-native-staging-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  const put = async (relative: string, name: string, dependencies: Record<string, string> = {}) => {
    const directory = path.join(root, 'node_modules', relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'index.js', dependencies }),
    );
    await fs.writeFile(path.join(directory, 'index.js'), 'module.exports=' + JSON.stringify(relative));
    return directory;
  };
  await put('serialport', 'serialport', { shared: '1' });
  const pty = await put('node-pty', 'node-pty', { shared: '1' });
  await put('@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk', { shared: '2' });
  await put('zod', 'zod');
  await put('shared', 'shared');
  await put('@modelcontextprotocol/sdk/node_modules/shared', 'shared');
  await fs.writeFile(path.join(pty, 'native.node'), 'native fixture');
  await fs.writeFile(path.join(pty, '.env'), 'must not be packaged');
  const result = await prepareRuntimeStage({ ...context, appDir: root }),
    local = createRequire(path.join(result.directory, '../package.json'));
  assert.ok(result.packages.includes('node_modules/node-pty'));
  assert.equal(
    await fs.readFile(path.join(result.directory, 'node-pty', 'native.node'), 'utf8'),
    'native fixture',
  );
  assert.equal(await fs.stat(path.join(result.directory, 'node-pty', '.env')).catch(() => null), null);
  const topShared = require(path.join(result.directory, 'shared')),
    nestedShared = require(path.join(result.directory, '@modelcontextprotocol/sdk/node_modules/shared'));
  assert.equal(topShared, 'shared');
  assert.equal(nestedShared, '@modelcontextprotocol/sdk/node_modules/shared');
  await fs.symlink(path.join(root, 'package.json'), path.join(pty, 'linked.json'), 'file');
  await assert.rejects(() => prepareRuntimeStage({ ...context, appDir: root }), /symbolic link/);
  assert.deepEqual(await fs.readdir(result.directory), []);
});
