import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { findClangd } from '../src/core/clangd/discovery';
import { clangdRelease, clangdExecutable, clangdHostSupported } from '../src/core/clangd/manifest';

test('clangd release metadata pins supported hosts and checksums', () => {
  const windows = clangdRelease('win32', 'x64')!;
  assert.equal(windows.version, '23.1.0');
  assert.match(windows.downloadUrl, /clangd-windows-23\.1\.0\.zip$/);
  assert.match(windows.sha256, /^[a-f0-9]{64}$/);
  assert.ok(windows.size > 1_000_000);
  assert.match(clangdRelease('linux', 'x64')!.downloadUrl, /clangd-linux-23\.1\.0\.zip$/);
  assert.match(clangdRelease('darwin', 'x64')!.downloadUrl, /clangd-mac-23\.1\.0\.zip$/);
  assert.equal(clangdRelease('linux', 'arm64'), undefined);
  assert.equal(clangdHostSupported('linux', 'arm64'), false);
  assert.equal(clangdExecutable('win32'), 'clangd.exe');
  assert.equal(clangdExecutable('linux'), 'clangd');
});

test('clangd discovery prefers custom, bundled, managed and then PATH', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-discovery-'));
  try {
    const executable = clangdExecutable('win32');
    const bundled = path.join(root, 'clangd', 'bin', executable);
    const managed = path.join(root, 'versions', 'clangd', '23.1.0', 'bin', executable);
    const custom = path.join(root, 'custom', executable);
    const pathFile = path.join(root, 'path', executable);
    for (const file of [bundled, managed, custom, pathFile]) {
      await writeFile(file, 'fixture').catch(async () => {
        await (await import('node:fs/promises')).mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'fixture');
      });
    }
    const probe = async () => '23.1.0';
    const found = (options: Parameters<typeof findClangd>[0]) =>
      findClangd({ platform: 'win32', arch: 'x64', probe, ...options });

    assert.equal(
      (await found({ toolchainRoot: root, env: { PATH: path.join(root, 'path') } }))?.path,
      bundled,
    );
    await rm(bundled);
    assert.equal(
      (await found({ toolchainRoot: root, env: { PATH: path.join(root, 'path') } }))?.path,
      managed,
    );
    assert.equal(
      (
        await found({
          toolchainRoot: root,
          configuredPath: custom,
          env: { PATH: path.join(root, 'path') },
        })
      )?.source,
      'custom',
    );
    assert.equal(
      (await found({ toolchainRoot: path.join(root, 'missing'), env: { PATH: path.join(root, 'path') } }))
        ?.source,
      'path',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
