import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { developmentRuntimeExecutables, ensureWindowsRuntimeIntegrity } from '../scripts/windows-runtime.mjs';

const run = promisify(execFile);

test(
  'Low-labelled runtime repair restores Medium child integrity without changing its DACL',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'blode-runtime-integrity-'));
    const file = path.join(directory, 'runtime with spaces.exe');
    const mediumFile = path.join(directory, '另一个 runtime.exe');
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const icacls = path.join(system, 'icacls.exe');
    const powershell = path.join(system, 'WindowsPowerShell/v1.0/powershell.exe');
    const command = `[IO.File]::GetAccessControl('${file.replaceAll("'", "''")}').GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)`;
    const acl = async () =>
      (
        await run(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(command, 'utf16le').toString('base64'),
          ],
          { windowsHide: true },
        )
      ).stdout.trim();
    try {
      await copyFile(path.join(system, 'whoami.exe'), file);
      await copyFile(path.join(system, 'whoami.exe'), mediumFile);
      const originalDacl = await acl();
      await run(icacls, [file, '/setintegritylevel', 'Low'], { windowsHide: true });
      const low = await ensureWindowsRuntimeIntegrity([file, mediumFile], { repair: false });
      assert.equal(low.files.length, 2);
      assert.equal(low.files[0].before, 4096);
      assert.equal(low.files[0].after, 4096);
      assert.equal(low.files[0].repaired, false);
      assert.equal(low.files[1].before, 8192);
      assert.equal(low.files[1].repaired, false);
      assert.match((await run(file, ['/groups'], { windowsHide: true })).stdout, /S-1-16-4096/);

      const repaired = await ensureWindowsRuntimeIntegrity([file, mediumFile]);
      assert.equal(repaired.files[0].before, 4096);
      assert.equal(repaired.files[0].after, 8192);
      assert.equal(repaired.files[0].repaired, true);
      assert.equal(repaired.files[1].after, 8192);
      assert.equal(repaired.files[1].repaired, false);
      assert.equal(await acl(), originalDacl);
      assert.match((await run(file, ['/groups'], { windowsHide: true })).stdout, /S-1-16-8192/);

      const unchanged = await ensureWindowsRuntimeIntegrity([file]);
      assert.equal(unchanged.files[0].before, 8192);
      assert.equal(unchanged.files[0].repaired, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('runtime integrity helper is a no-op for an empty list', async () => {
  assert.deepEqual(await ensureWindowsRuntimeIntegrity([]), { processIntegrity: null, files: [] });
});

test(
  'development integrity checks select only actual startup children, including a Low-labelled bundler',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'blode-dev-runtime-'));
    const savedOverride = process.env.ESBUILD_BINARY_PATH;
    delete process.env.ESBUILD_BINARY_PATH;
    t.after(async () => {
      if (savedOverride === undefined) delete process.env.ESBUILD_BINARY_PATH;
      else process.env.ESBUILD_BINARY_PATH = savedOverride;
      await rm(root, { recursive: true, force: true });
    });
    const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
    const bundlerDirectory = path.join(root, `node_modules/@esbuild/win32-${process.arch}`);
    const bundler = path.join(bundlerDirectory, 'esbuild.exe');
    const esbuildDirectory = path.join(root, 'node_modules/esbuild/lib');
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const ignored = path.join(root, 'tools/old-sdk/deep/unused.exe');
    for (const directory of [
      path.dirname(electron),
      bundlerDirectory,
      esbuildDirectory,
      path.dirname(ignored),
    ])
      await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(root, 'node_modules/esbuild/package.json'),
      JSON.stringify({ main: 'lib/main.js' }),
    );
    await writeFile(path.join(esbuildDirectory, 'main.js'), '');
    await copyFile(path.join(system, 'whoami.exe'), electron);
    await copyFile(path.join(system, 'whoami.exe'), bundler);
    await writeFile(ignored, 'unrelated SDK');
    await run(path.join(system, 'icacls.exe'), [bundler, '/setintegritylevel', 'Low'], { windowsHide: true });
    const files = await developmentRuntimeExecutables(electron, root);
    assert.deepEqual(files, [electron, bundler]);
    const report = await ensureWindowsRuntimeIntegrity(files);
    assert.equal(report.files.length, 2);
    assert.equal(report.files[1]!.before, 4096);
    assert.equal(report.files[1]!.after, 8192);
    assert.equal(report.files[1]!.repaired, true);

    process.env.ESBUILD_BINARY_PATH = path.join(root, 'missing-override.exe');
    assert.deepEqual(
      await developmentRuntimeExecutables(electron, root),
      [electron, bundler],
      'a missing override must fall back to the installed package like esbuild does',
    );
    process.env.ESBUILD_BINARY_PATH = ignored;
    assert.deepEqual(
      await developmentRuntimeExecutables(electron, root),
      [electron, ignored],
      'an explicitly selected alternate bundler is checked without walking tools',
    );
  },
);
