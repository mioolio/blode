import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpawnOptions } from 'node:child_process';
import { findVSCodeExecutable, openVSCode, type VSCodeOptions } from '../src/core/vscode';
import { createHostServices } from '../src/core/host-services';
import { startWebServer } from '../src/core/web';
import { createWorkbenchBridge } from '../src/shared/workbench-bridge';
import { getBoardAdapter } from '../extensions/registry';

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-vscode-test-'));
  const project = path.join(directory, 'team project & $(echo never)');
  const other = path.join(directory, 'other');
  const executable = path.join(directory, 'VS Code', 'Code.exe');
  await Promise.all([project, other, path.dirname(executable)].map((file) => fs.mkdir(file)));
  await fs.writeFile(executable, 'test fixture, never executed');
  await fs.mkdir(path.join(project, 'src'));
  const file = 'src/main & unit.c';
  await fs.writeFile(path.join(project, file), 'int main(void) { return 0; }\n');
  let currentProject = project;
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  const launches: { executable: string; args: string[]; options: SpawnOptions }[] = [];
  const options: VSCodeOptions = {
    projectRoot: () => currentProject,
    config: () => config,
    findExecutable: async () => executable,
    launch: async (executable, args, options) => {
      launches.push({ executable, args, options });
    },
  };
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^blode-vscode-test-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    project,
    other,
    file,
    executable,
    config,
    options,
    launches,
    switchProject: () => {
      currentProject = other;
    },
  };
}

test('VS Code opens a portable workspace and literal file/line arguments without touching .vscode', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, '.vscode'));
  const original = '{ "editor.tabSize": 3 }\n';
  await fs.writeFile(path.join(f.project, '.vscode', 'settings.json'), original);
  const compilerDirectory = path.join(f.directory, 'Arm tools');
  await fs.mkdir(path.join(compilerDirectory, 'bin'), { recursive: true });
  const compiler = path.join(
    compilerDirectory,
    'bin',
    process.platform === 'win32' ? 'armclang.exe' : 'armclang',
  );
  await fs.writeFile(compiler, 'compiler fixture');
  f.config.toolchain.armCompilerDirectory = compilerDirectory;
  const result = await openVSCode(
    { ...f.options, env: { ELECTRON_RUN_AS_NODE: '1' } },
    {
      expectedProjectRoot: f.project,
      path: f.file,
      line: 12,
      column: 7,
      confirm: true,
    },
  );
  const generated = JSON.parse(await fs.readFile(result.workspaceFile, 'utf8'));
  assert.deepEqual(generated.folders, [{ name: path.basename(f.project), path: '../..' }]);
  assert.equal(path.resolve(path.dirname(result.workspaceFile), generated.folders[0].path), f.project);
  assert.equal(generated.settings['files.autoSave'], 'afterDelay');
  assert.equal(generated.settings['files.encoding'], 'utf8');
  assert.deepEqual(generated.settings['files.associations'], { '*.ino': 'cpp' });
  assert.deepEqual(generated.settings['C_Cpp.default.includePath'], ['${workspaceFolder}/**']);
  assert.equal(generated.settings['C_Cpp.default.compilerPath'], compiler);
  assert.deepEqual(generated.extensions.recommendations, ['ms-vscode.cpptools']);
  assert.equal(await fs.readFile(path.join(f.project, '.vscode/settings.json'), 'utf8'), original);
  assert.deepEqual(f.launches[0].args, [
    '--reuse-window',
    result.workspaceFile,
    '--goto',
    `${path.join(f.project, f.file)}:12:7`,
  ]);
  assert.equal(f.launches[0].executable, f.executable);
  assert.equal(f.launches[0].options.shell, false);
  assert.equal(f.launches[0].options.cwd, f.project);
  assert.equal(f.launches[0].options.env?.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.launches[0].options.windowsHide, true);
  assert.deepEqual(await fs.readdir(path.dirname(result.workspaceFile)), ['project.code-workspace']);
});

test('workspace-only launches omit goto and absent compiler paths, and can update generated configuration', async (t) => {
  const f = await fixture(t);
  f.config.toolchain.armCompilerDirectory = path.join(f.directory, 'missing compiler');
  const request = { expectedProjectRoot: f.project, confirm: true as const };
  const first = await openVSCode(f.options, request);
  const second = await openVSCode(f.options, request);
  assert.deepEqual(first, second);
  assert.deepEqual(f.launches[0].args, ['--reuse-window', first.workspaceFile]);
  const generated = JSON.parse(await fs.readFile(first.workspaceFile, 'utf8'));
  assert.equal(Object.hasOwn(generated.settings, 'C_Cpp.default.compilerPath'), false);
  assert.deepEqual(await fs.readdir(path.dirname(first.workspaceFile)), ['project.code-workspace']);
});

test('cross-project and stale-project requests do not generate or launch a workspace', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    openVSCode(f.options, { expectedProjectRoot: f.other, confirm: true }),
    /vscodeProjectChanged/,
  );
  await assert.rejects(
    openVSCode(
      {
        ...f.options,
        findExecutable: async () => {
          f.switchProject();
          return f.executable;
        },
      },
      {
        expectedProjectRoot: f.project,
        confirm: true,
      },
    ),
    /vscodeProjectChanged/,
  );
  assert.equal(f.launches.length, 0);
  assert.equal(await fs.stat(path.join(f.project, '.blode')).catch(() => undefined), undefined);
  assert.equal(await fs.stat(path.join(f.other, '.blode')).catch(() => undefined), undefined);
});

test('project traversal and symlinked configuration/source paths are refused before launching', async (t) => {
  const f = await fixture(t);
  for (const file of ['../escape.c', '.vscode/settings.json', f.executable])
    await assert.rejects(
      openVSCode(f.options, { expectedProjectRoot: f.project, path: file, confirm: true }),
    );
  await fs.symlink(
    f.other,
    path.join(f.project, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await fs.writeFile(path.join(f.other, 'source.c'), 'outside');
  await assert.rejects(
    openVSCode(f.options, { expectedProjectRoot: f.project, path: 'linked/source.c', confirm: true }),
    /symlinkPath/,
  );
  await fs.symlink(
    f.other,
    path.join(f.project, '.blode'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    openVSCode(f.options, { expectedProjectRoot: f.project, confirm: true }),
    /symlinkPath/,
  );
  assert.equal(f.launches.length, 0);
  assert.deepEqual(await fs.readdir(f.other), ['source.c']);
});

test('missing VS Code and launch failures are distinct errors', async (t) => {
  const f = await fixture(t);
  await assert.rejects(findVSCodeExecutable({ env: {}, isExecutable: async () => false }), /vscodeNotFound/);
  await assert.rejects(
    openVSCode(
      {
        ...f.options,
        findExecutable: async () => {
          throw new Error('error.vscodeNotFound');
        },
      },
      {
        expectedProjectRoot: f.project,
        confirm: true,
      },
    ),
    /vscodeNotFound/,
  );
  assert.equal(await fs.stat(path.join(f.project, '.blode')).catch(() => undefined), undefined);
  await assert.rejects(
    openVSCode(
      {
        ...f.options,
        launch: async () => {
          throw new Error('spawn failed');
        },
      },
      {
        expectedProjectRoot: f.project,
        confirm: true,
      },
    ),
    /vscodeLaunch/,
  );
});

test('Windows PATH discovery resolves the official bin launcher to Code.exe without executing code.cmd', async () => {
  const bin = path.resolve('VS Code fixture', 'bin');
  const expected = path.join(bin, '..', 'Code.exe');
  const visited: string[] = [];
  assert.equal(
    await findVSCodeExecutable({
      platform: 'win32',
      env: { PATH: bin },
      isExecutable: async (file) => {
        visited.push(file);
        return file === expected;
      },
    }),
    expected,
  );
  assert.ok(visited.every((file) => !/\.(?:cmd|bat)$/i.test(file)));
});

test('Linux and macOS discovery have official installation fallbacks', async () => {
  assert.equal(
    await findVSCodeExecutable({
      platform: 'linux',
      env: {},
      isExecutable: async (file) => file === '/usr/share/code/code',
    }),
    '/usr/share/code/code',
  );
  const mac = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
  assert.equal(
    await findVSCodeExecutable({ platform: 'darwin', env: {}, isExecutable: async (file) => file === mac }),
    mac,
  );
});

test('host routing and bridge share explicit confirmation, expected root and coordinate validation', async (t) => {
  const f = await fixture(t);
  const services = createHostServices({
    core: { currentProjectRoot: f.options.projectRoot, currentConfig: () => f.config } as any,
    collaboration: {} as any,
    firmware: {} as any,
    recent: {} as any,
    dataRoot: f.directory,
    toolchainRoot: f.directory,
    emit() {},
    vscode: { findExecutable: f.options.findExecutable, launch: f.options.launch },
  });
  t.after(() => services.close());
  const request = { expectedProjectRoot: f.project, path: f.file, confirm: true as const };
  const bridge = createWorkbenchBridge(services.invoke, () => () => {});
  const result = await bridge.vscodeOpen(request);
  assert.equal(result.executable, f.executable);
  await services.automationInvoke('vscode.open', request);
  for (const extra of [
    { confirm: false },
    { line: 0 },
    { column: 1.5 },
    { unexpected: true },
    { expectedProjectRoot: '' },
  ])
    await assert.rejects(services.invoke('vscodeOpen', [{ ...request, ...extra }]), /invalidParams/);
  await assert.rejects(
    services.invoke('vscodeOpen', [{ expectedProjectRoot: f.project, line: 2, confirm: true }]),
    /invalidParams/,
  );
  assert.equal(f.launches.length, 2);
});

test('authenticated Web requests open VS Code on the host with the same project and path checks', async (t) => {
  const f = await fixture(t);
  const server = await startWebServer({
    api: { getState: async () => ({ projectRoot: f.project }) } as any,
    hostServices: {
      invoke: async (method, args) => {
        assert.equal(method, 'vscodeOpen');
        return openVSCode(f.options, args[0] as any);
      },
    },
    dataRoot: f.directory,
    appRoot: f.directory,
    isPackaged: true,
    allowExternal: false,
    requireToken: true,
    port: 0,
  });
  t.after(() => server.close());
  const token = (await fs.readFile(server.tokenFile, 'utf8')).trim();
  const request = (authorized: boolean, expectedProjectRoot = f.project) =>
    fetch(server.endpoint + '/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { 'x-blode-token': token } : {}),
      },
      body: JSON.stringify({
        method: 'vscodeOpen',
        args: [{ expectedProjectRoot, path: f.file, confirm: true }],
      }),
    });
  const denied = await request(false);
  assert.equal(denied.status, 401);
  await denied.text();
  assert.equal(f.launches.length, 0);
  const opened = await request(true);
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).executable, f.executable);
  const changed = await request(true, f.other);
  assert.equal(changed.status, 400);
  assert.match(await changed.text(), /vscodeProjectChanged/);
  assert.equal(f.launches.length, 1);
});
