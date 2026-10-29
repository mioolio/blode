import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseWebArguments, startStandaloneHost } from '../scripts/web-server';
import { releaseFiles } from '../scripts/package-web';

test('standalone Web CLI validates bind addresses, ports and target paths', () => {
  assert.deepEqual(parseWebArguments([]), {});
  assert.equal(parseWebArguments(['--help']).help, true);
  const options = parseWebArguments([
    '--host',
    '0.0.0.0',
    '--port',
    '0',
    '--project',
    '.',
    '--data-root',
    '.tools',
  ]);
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 0);
  assert.ok(path.isAbsolute(options.project!));
  for (const args of [
    ['--host', 'example.com'],
    ['--port', '-1'],
    ['--port', '65536'],
    ['--port', '2.5'],
    ['--project'],
    ['--unknown'],
  ])
    assert.throws(() => parseWebArguments(args));
});

test(
  'standalone host authenticates loopback RPC and browses projects on the host',
  { timeout: 30_000 },
  async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-web-host-'));
    const workspace = path.join(temporary, 'target-project');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'main.c'), 'int main(void) { return 0; }\n');
    const renderer = path.join(temporary, 'dist', 'renderer');
    await fs.mkdir(renderer, { recursive: true });
    await fs.writeFile(path.join(renderer, 'index.html'), '<!doctype html><title>Test host</title>');
    const host = await startStandaloneHost({
      port: 0,
      dataRoot: path.join(temporary, 'data'),
      appRoot: temporary,
      createRuntimes: () => [],
      refreshDevices: false,
    });
    try {
      const token = (await fs.readFile(host.web.tokenFile, 'utf8')).trim();
      const rpc = (method: string, args: unknown[], authorized = true) =>
        fetch(host.web.endpoint + '/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(authorized ? { 'x-blode-token': token } : {}) },
          body: JSON.stringify({ method, args }),
        });
      const unauthorized = await rpc('getState', [], false);
      assert.equal(unauthorized.status, 401);
      await unauthorized.text();
      const initialResponse = await rpc('getState', []);
      assert.equal(initialResponse.status, 200);
      const initial = await initialResponse.json();
      assert.equal(initial.workspaceOpen, false);
      assert.equal(initial.projectRoot, '');
      assert.ok(Array.isArray(initial.ports));
      const browseResponse = await rpc('hostBrowse', [temporary]);
      assert.equal(browseResponse.status, 200);
      const browse = await browseResponse.json();
      assert.ok(browse.entries.some((entry: { name: string }) => entry.name === 'target-project'));
      const open = await rpc('hostOpenProject', [workspace]);
      assert.equal(open.status, 200);
      await open.text();
      const stateResponse = await rpc('getState', []);
      const state = await stateResponse.json();
      assert.equal(state.workspaceOpen, true);
      assert.equal(state.projectRoot, await fs.realpath(workspace));
      assert.ok(state.files.some((file: { path: string }) => file.path === 'main.c'));
      assert.equal(state.recentProjects[0].path, await fs.realpath(workspace));
      const toolsResponse = await rpc('toolVersionsState', []);
      assert.equal(toolsResponse.status, 200);
      const catalog = await toolsResponse.json();
      assert.ok(catalog.entries.some((entry: { id: string }) => entry.id === 'gnu-arm:14.2.1-1.1'));
      assert.equal(catalog.platform, process.platform);
      const previewResponse = await rpc('projectPackagePreview', []);
      const preview = await previewResponse.json();
      assert.equal(preview.externalCount, 0);
      assert.ok(preview.files.some((file: { destination: string }) => file.destination === 'main.c'));
      const exportResponse = await rpc('projectPackageExport', [{}]);
      assert.equal(exportResponse.status, 200);
      const archive = await exportResponse.json();
      const download = await fetch(`${host.web.endpoint}/project/package/${archive.id}`, {
        headers: { 'x-blode-token': token },
      });
      assert.equal(download.status, 200);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      assert.equal(bytes.length, archive.size);
      const command =
        process.platform === 'win32' ? 'Write-Output "blode-web-fixture"' : "printf 'blode-web-fixture\\n'";
      const terminalResponse = await rpc('terminalRun', [{ command }]);
      assert.equal(terminalResponse.status, 200);
      await terminalResponse.text();
      let terminal;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await rpc('terminalState', []);
        terminal = await response.json();
        if (!terminal.running) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(terminal.running, false);
      assert.equal(terminal.exitCode, 0);
      assert.equal(terminal.cwd, await fs.realpath(workspace));
      assert.ok(terminal.lines.includes('blode-web-fixture'));
    } finally {
      await host.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  },
);

test('Web release file enumeration cannot follow a link into host credentials', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-web-release-test-'));
  const renderer = path.join(temporary, 'renderer');
  const credentials = path.join(temporary, 'credentials');
  await fs.mkdir(renderer);
  await fs.mkdir(credentials);
  await fs.writeFile(path.join(credentials, 'token'), 'fixture-only');
  await fs.symlink(
    credentials,
    path.join(renderer, 'unsafe'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  try {
    await assert.rejects(async () => {
      for await (const _file of releaseFiles(renderer, 'dist/renderer')) {
        /* enumerate */
      }
    }, /symbolic links/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
