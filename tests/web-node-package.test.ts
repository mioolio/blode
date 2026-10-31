import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nodeWebLauncher } from '../scripts/package-web-node';

const execute = promisify(execFile);

test('Node Web launcher reports its release and forwards arguments from an independent path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode web node '));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const launcher = path.join(root, 'launch-web.cjs');
  await fs.writeFile(launcher, nodeWebLauncher);
  await fs.writeFile(path.join(root, 'release.json'), JSON.stringify({ releaseVersion: '0.3.5.2' }));
  const version = await execute(process.execPath, [launcher, '--version'], {
    cwd: os.tmpdir(),
    windowsHide: true,
  });
  assert.match(version.stdout, /0\.3\.5\.2.*Node\.js/);
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(
    path.join(root, 'dist', 'web-server.cjs'),
    'console.log(JSON.stringify({args:process.argv.slice(2),open:process.env.BLODE_WEB_OPEN_BROWSER}));',
  );
  const project = path.join(root, 'project with spaces');
  const quiet = await execute(
    process.execPath,
    [launcher, '--no-open', '--project', project, '--port', '0'],
    { cwd: os.tmpdir(), windowsHide: true },
  );
  assert.deepEqual(JSON.parse(quiet.stdout), { args: ['--project', project, '--port', '0'] });
  const normal = await execute(process.execPath, [launcher, '--port', '0'], {
    cwd: os.tmpdir(),
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(normal.stdout), { args: ['--port', '0'], open: '1' });
});
