import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core/service';
import { persistConfig, ensureProjectMarker } from '../src/core/workspace';
import { getBoardAdapter } from '../extensions/registry';
import { createWebDebugger } from '../src/core/web-debugger';
import { isDebuggerWindowMethod } from '../src/core/debugger-window-access';
import type { HardwareDebugger } from '../src/core/hardware-debugger';
import type { DebuggerSettingsRequest } from '../src/shared/contracts';

async function fixture(t: TestContext, workspace = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-debug-settings-'));
  const project = path.join(directory, 'project');
  await fs.mkdir(project);
  await ensureProjectMarker(project);
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  config.debugger = { gdbPath: '/tools/gdb', serverPath: '/tools/openocd' };
  await persistConfig(project, config);
  let active = false;
  const core = await createCore({
    projectRoot: workspace ? project : '',
    dataRoot: path.join(directory, 'data'),
    onEvent() {},
    createRuntimes: () => [],
    refreshDevices: false,
    hardwareBusy: () => active,
  });
  t.after(async () => {
    await core.shutdown();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^blode-debug-settings-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request: DebuggerSettingsRequest = {
    expectedProjectRoot: core.currentProjectRoot(),
    expectedBoardId: core.currentConfig().boardId,
    debugger: { transport: 'uart-gdb', port: 'COM3', baudRate: 115200, stubMode: 'runtime' },
  };
  return {
    core,
    project,
    request,
    setActive(value: boolean) {
      active = value;
    },
  };
}

test('debugger window can refresh COM ports and save scoped settings without project write permission', () => {
  for (const method of [
    'getState',
    'listPorts',
    'listDebugProbes',
    'debuggerSaveSettings',
    'debuggerConnect',
    'debuggerAction',
    'windowAction',
    'hostBrowse',
  ])
    assert.equal(isDebuggerWindowMethod(method), true, method);
  for (const method of [
    'saveConfig',
    'saveFile',
    'deleteEntry',
    'selectProject',
    'build',
    'flash',
    'serialOpen',
    'terminalWrite',
    'desktopCloseReply',
    null,
    {},
    42,
  ])
    assert.equal(isDebuggerWindowMethod(method), false, String(method));
});

test('scoped debugger save merges against current configuration and preserves project and build fields', async (t) => {
  const f = await fixture(t);
  // Main-window settings change after the debugger window captured its configuration.
  const current = f.core.currentConfig();
  current.name = 'New project name';
  current.toolchain.python = '/new/python';
  await f.core.saveConfig(current);
  await f.core.setBuildEntry('.');
  const before = JSON.parse(await fs.readFile(path.join(f.project, 'be'), 'utf8'));
  await f.core.debuggerSaveSettings(f.request);
  const after = JSON.parse(await fs.readFile(path.join(f.project, 'be'), 'utf8'));
  const expected = { ...before, debugger: { ...before.debugger, ...f.request.debugger } };
  assert.deepEqual(after, expected);
  assert.equal(f.core.currentConfig().name, 'New project name');
  assert.equal(f.core.currentConfig().debugger?.gdbPath, '/tools/gdb');
  assert.equal(f.core.currentConfig().debugger?.port, 'COM3');
});

test('stale project or platform requests cannot modify the current project', async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.project, 'be'), 'utf8');
  await assert.rejects(
    f.core.debuggerSaveSettings({ ...f.request, expectedProjectRoot: f.project + '-other' }),
    /debuggerProjectChanged/,
  );
  await assert.rejects(
    f.core.debuggerSaveSettings({ ...f.request, expectedBoardId: 'STM32F103C8T6' }),
    /debuggerProjectChanged/,
  );
  await f.core.closeProject();
  await assert.rejects(f.core.debuggerSaveSettings(f.request), /debuggerProjectChanged/);
  assert.equal(await fs.readFile(path.join(f.project, 'be'), 'utf8'), before);
});

test('debugger settings reject unrelated mutations and active hardware before writing', async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { ...f.request, name: 'unauthorized rename' },
    { ...f.request, toolchain: { python: '/untrusted/python' } },
    { ...f.request, debugger: { ...f.request.debugger, name: 'unknown' } },
    { ...f.request, debugger: { baudRate: 0 } },
  ])
    await assert.rejects(f.core.debuggerSaveSettings(invalid as DebuggerSettingsRequest), /invalidArguments/);
  f.setActive(true);
  await assert.rejects(f.core.debuggerSaveSettings(f.request), /debuggerOwnsDevice/);
  f.setActive(false);
  await f.core.runDebuggerAction(async () => {
    await assert.rejects(f.core.debuggerSaveSettings(f.request), /error.busy/);
  });
  assert.equal(f.core.currentConfig().debugger?.port, undefined);
});

test('standalone debugging can save session settings without opening or creating a project', async (t) => {
  const f = await fixture(t, false);
  const before = await fs.readFile(path.join(f.project, 'be'), 'utf8');
  await f.core.debuggerSaveSettings(f.request);
  assert.equal(f.core.currentProjectRoot(), '');
  assert.equal(f.core.currentConfig().boardId, 'auto');
  assert.equal(f.core.currentConfig().debugger?.port, 'COM3');
  assert.equal(await fs.readFile(path.join(f.project, 'be'), 'utf8'), before);
});

test('Web debugger uses the same scoped settings operation and rejects broad config payloads', async (t) => {
  const f = await fixture(t);
  const web = createWebDebugger({} as HardwareDebugger, f.core);
  await web.invoke('debuggerSaveSettings', [f.request]);
  assert.equal(f.core.currentConfig().debugger?.port, 'COM3');
  await assert.rejects(
    web.invoke('debuggerSaveSettings', [{ ...f.request, config: f.core.currentConfig() }]),
    /invalidParams/,
  );
  await assert.rejects(
    web.invoke('debuggerSaveSettings', [{ ...f.request, expectedBoardId: 'STM32F103C8T6' }]),
    /debuggerProjectChanged/,
  );
});
