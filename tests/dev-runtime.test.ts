import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasFatalStartupError,
  classifyElectronExit,
  findStaleElectronProcesses,
  findStaleVite,
  recoverStaleElectron,
  recoverStaleVite,
  recoverStaleDevProcesses,
  stopProcessTree,
  type ProcessInventoryEntry,
} from '../scripts/dev-runtime.mjs';

const electron = 'C:\\work\\app\\node_modules\\electron\\dist\\electron.exe';
const profile = 'C:\\work\\app\\.tools\\dev user data';
const node = 'C:\\Program Files\\nodejs\\node.exe';
const vite = 'C:\\work\\app\\node_modules\\vite\\bin\\vite.js';
const entry = (
  pid: number,
  command: string | null,
  executable = electron,
  parentPid = 1,
): ProcessInventoryEntry => ({
  ProcessId: pid,
  ParentProcessId: parentPid,
  ExecutablePath: executable,
  CommandLine: command,
});

test('closing normally never retries a historical renderer crash, including before mounting', () => {
  for (const log of [
    '',
    '2026-10-30T00:00:00Z window first paint',
    '2026-10-30T00:00:00Z render-process-gone crashed exit=-2147483645',
    '2026-10-30T00:00:00Z child-process-gone GPU crashed exit=1',
    '2026-10-30T00:00:00Z window ready\n2026-10-30T00:00:01Z render-process-gone crashed exit=-2147483645',
  ]) {
    assert.deepEqual(classifyElectronExit({ code: 0, timedOut: false, log }), {
      retry: null,
      failed: false,
      exitCode: 0,
    });
  }
});

test('actual sandbox failure and startup timeout retain bounded recovery', () => {
  for (const code of [0x80000003, -2147483645]) {
    const result = { code, timedOut: false, log: '' };
    assert.equal(classifyElectronExit(result).retry, 'sandbox');
    assert.equal(classifyElectronExit(result, { sandbox: true }).retry, 'software');
    assert.equal(classifyElectronExit(result, { sandbox: true, software: true }).retry, null);
    assert.equal(classifyElectronExit(result, { sandbox: true, software: true }).failed, true);
  }
  const rendererFatal = {
    code: 0,
    timedOut: false,
    log: '2026-10-30T00:00:00Z render-process-gone crashed exit=-2147483645\n2026-10-30T00:00:01Z fatal Error: ERR_FAILED',
  };
  assert.equal(classifyElectronExit(rendererFatal).retry, 'sandbox');
  const timeout = { code: null, timedOut: true, log: '' };
  assert.equal(classifyElectronExit(timeout).retry, 'software');
  assert.deepEqual(classifyElectronExit(timeout, { software: true }), {
    retry: null,
    failed: true,
    exitCode: 1,
  });
  const mountedFailure = { code: 1, timedOut: false, log: '2026-10-30T00:00:00Z window ready' };
  assert.deepEqual(classifyElectronExit(mountedFailure), { retry: null, failed: true, exitCode: 1 });
  assert.equal(
    classifyElectronExit({ ...rendererFatal, log: '2026-10-30T00:00:00Z fatal Error: service failure' })
      .failed,
    true,
  );
});

test('a mounted interface does not mask a later fatal service initialization error', () => {
  const mounted = '2026-10-29T00:00:00.000Z window ready interface=mounted elapsed=240ms';
  assert.equal(hasFatalStartupError(mounted), false);
  assert.equal(
    hasFatalStartupError(`${mounted}\n2026-10-29T00:00:00.100Z fatal Error: pipe startup failed\nstack`),
    true,
  );
  assert.equal(hasFatalStartupError('2026-10-29T00:00:00.000Z fatal userData is not writable'), true);
  assert.equal(
    hasFatalStartupError(`${mounted}\n2026-10-29T00:00:00.100Z renderer-console fatal message`),
    false,
  );
  // An ordinary user exit immediately after mounting needs no services-ready marker.
  assert.equal(
    hasFatalStartupError(`${mounted}\n2026-10-29T00:00:00.100Z development launcher disconnected`),
    false,
  );
});

test('Electron recovery matches exact executable/profile across quoted Windows argument forms', async () => {
  const inventory = [
    entry(101, `"${electron}" "--user-data-dir=${profile}" .`),
    entry(102, `"${electron}" --type=gpu-process --user-data-dir="${profile}"`, electron, 101),
    entry(103, `"${electron}" --type=renderer --user-data-dir "${profile.toUpperCase()}\\"`, electron, 101),
    entry(104, `"${electron}" --user-data-dir="${profile}-other" .`),
    entry(105, `"${electron}" --user-data-dir="${profile}\\other" .`),
    entry(106, `"${electron}" --user-data-dir="${profile}" .`, 'C:\\other\\electron.exe'),
    entry(107, `"${electron}" --profile-directory="${profile}" .`),
    entry(108, `"${electron}" --user-data-dir="${profile}" --user-data-dir=C:\\other .`),
    entry(109, null),
    entry(110, `"${electron}" --user-data-dir="${profile}" .`, electron, 1),
    entry(400, `"${node}" scripts/dev.mjs`, node, 1),
    entry(401, `"${electron}" --user-data-dir="${profile}" .`, electron, 400),
    entry(402, `"${electron}" --type=gpu-process --user-data-dir="${profile}"`, electron, 401),
    entry(403, `"${electron}" -- other-app.js "--user-data-dir=${profile}"`),
  ];
  // A literal final backslash in quotes must be doubled under Windows quoting.
  inventory[2].CommandLine = `"${electron}" --type=renderer --user-data-dir "${profile.toUpperCase()}\\\\"`;
  const found = await findStaleElectronProcesses(electron.toUpperCase(), profile, { inventory });
  assert.deepEqual(found, [
    { pid: 101, parentPid: 1 },
    { pid: 102, parentPid: 101 },
    { pid: 103, parentPid: 101 },
    { pid: 110, parentPid: 1 },
  ]);
  assert.ok(found.every((process) => Object.keys(process).sort().join(',') === 'parentPid,pid'));
  const killed: number[] = [];
  const stopped = await recoverStaleElectron(electron, profile, {
    inventory,
    stopProcessTree: async (pid) => {
      killed.push(pid);
      return true;
    },
  });
  assert.deepEqual(killed, [101, 110]);
  assert.equal(stopped, 2);
});

test('a GPU process remains recoverable after its Electron parent has already exited', async () => {
  const inventory = [
    entry(501, `"${electron}" --type=gpu-process --user-data-dir="${profile}"`, electron, 999),
  ];
  assert.deepEqual(await findStaleElectronProcesses(electron, profile, { inventory }), [
    { pid: 501, parentPid: 999 },
  ]);
});

test('Vite recovery requires exact Node script and an absent parent', async () => {
  const inventory = [
    entry(200, 'parent process', node, 1),
    entry(201, `"${node}" "${vite}" --host 127.0.0.1`, node, 999),
    entry(202, `"${node}" "${vite}" --host 127.0.0.1`, node, 200),
    entry(203, `"${node}" C:\\other\\vite.js`, node, 999),
    entry(204, `"${node}" C:\\worker.js "${vite}"`, node, 999),
    entry(205, `"${node}" "${vite}"`, 'C:\\other\\node.exe', 999),
    entry(206, null, node, 999),
  ];
  assert.deepEqual(await findStaleVite(vite, node, { inventory }), [{ pid: 201, parentPid: 999 }]);
  const killed: number[] = [];
  assert.equal(
    await recoverStaleVite(vite, node, {
      inventory,
      stopProcessTree: async (pid) => {
        killed.push(pid);
        return true;
      },
    }),
    1,
  );
  assert.deepEqual(killed, [201]);
});

test('Windows termination uses only a validated owned PID and treats an exited child as stopped', async () => {
  const calls: unknown[] = [];
  assert.equal(
    await stopProcessTree(123, {
      platform: 'win32',
      execFile: async (...args) => {
        calls.push(args);
        return {};
      },
    }),
    true,
  );
  assert.deepEqual(calls, [
    ['taskkill.exe', ['/PID', '123', '/T', '/F'], { windowsHide: true, timeout: 10_000 }],
  ]);
  for (const pid of [0, -1, 1.2, process.pid])
    await assert.rejects(
      stopProcessTree(pid, {
        platform: 'win32',
        execFile: async () => {
          throw new Error('must not execute');
        },
      }),
      /Invalid owned process ID/,
    );
  assert.equal(
    await stopProcessTree(123, {
      platform: 'win32',
      execFile: async () => {
        throw Object.assign(new Error('not found'), { code: 128 });
      },
    }),
    false,
  );
  await assert.rejects(
    stopProcessTree(123, {
      platform: 'win32',
      execFile: async () => {
        throw Object.assign(new Error('denied'), { code: 1 });
      },
    }),
    /denied/,
  );
});

test('process inventory command is fixed and caller paths remain outside PowerShell source', async () => {
  const maliciousProfile = 'C:\\work\\profile; Write-Output secret';
  let captured: string[] = [];
  const found = await findStaleElectronProcesses(electron, maliciousProfile, {
    platform: 'win32',
    execFile: async (_command, args, options) => {
      captured = args;
      assert.equal(options.windowsHide, true);
      return { stdout: JSON.stringify(entry(301, `"${electron}" --user-data-dir="${maliciousProfile}"`)) };
    },
  });
  assert.deepEqual(found, [{ pid: 301, parentPid: 1 }]);
  assert.ok(captured.at(-1)?.includes('Get-CimInstance Win32_Process'));
  assert.ok(!captured.join(' ').includes(maliciousProfile));
});

test('startup recovers Electron and legacy Vite from one fresh process inventory', async () => {
  let reads = 0;
  const killed: number[] = [];
  const stopped = await recoverStaleDevProcesses(electron, profile, vite, node, {
    inventory: async () => {
      reads++;
      return [
        entry(701, `"${electron}" --user-data-dir="${profile}" .`, electron, 999),
        entry(702, `"${electron}" --type=gpu-process --user-data-dir="${profile}"`, electron, 701),
        entry(703, `"${node}" "${vite}" --host 127.0.0.1`, node, 999),
        entry(704, 'active parent', node, 1),
        entry(705, `"${electron}" --user-data-dir="${profile}" .`, electron, 704),
        entry(706, `"${node}" "${vite}"`, node, 704),
      ];
    },
    stopProcessTree: async (pid) => {
      killed.push(pid);
      return true;
    },
  });
  assert.equal(reads, 1);
  assert.equal(stopped, 2);
  assert.deepEqual(killed, [701, 703]);
});
