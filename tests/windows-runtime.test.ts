import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureWindowsRuntimeIntegrity } from '../scripts/windows-runtime.mjs';

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
