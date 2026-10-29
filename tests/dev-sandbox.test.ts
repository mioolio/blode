import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  hasReadyWindow,
  classifyElectronExit,
  resolveDevelopmentSandbox,
  rememberSandboxCompatibility,
  type DevelopmentSandboxOptions,
} from '../scripts/dev-runtime.mjs';

const stamp = '2026-10-30T00:00:00.000Z';
const ready = `${stamp} window ready interface=mounted elapsed=500ms`;
const crash = `${stamp} render-process-gone crashed exit=-2147483645 elapsed=128ms`;
const fatal = `${stamp} fatal Error: ERR_FAILED (-2) loading renderer`;
const verified = {
  failedAttempt: { code: 0, timedOut: false, log: `${crash}\n${fatal}` },
  recoveredLog: ready,
  sandboxDisabled: true,
};
const normal = { mode: 'sandbox', canRetrySandbox: true, source: 'default' };

async function setup(t: TestContext) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-dev-sandbox-test-'));
  t.after(async () => {
    assert.equal(path.dirname(workspaceRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(workspaceRoot), /^blode-dev-sandbox-test-/);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
  const options: DevelopmentSandboxOptions = {
    workspaceRoot,
    electronExecutable: 'C:\\work\\blode\\node_modules\\electron\\dist\\electron.exe',
    electronVersion: '45.1.0',
    profile: 'C:\\work\\blode\\.tools\\dev-user-data',
    platform: 'win32',
  };
  const files = () => fs.readdir(path.join(workspaceRoot, '.tools')).catch(() => [] as string[]);
  return { options, files };
}

test('verified compatibility persists only a mode and opaque runtime/profile key', async (t) => {
  const { options, files } = await setup(t);
  assert.deepEqual(await resolveDevelopmentSandbox(options), normal);
  assert.equal(await rememberSandboxCompatibility(options, verified), true);
  assert.deepEqual(await resolveDevelopmentSandbox(options), {
    mode: 'no-sandbox',
    canRetrySandbox: false,
    source: 'verified',
  });
  const [name] = await files();
  assert.match(name, /^dev-sandbox-[0-9a-f]{20}\.json$/);
  const content = JSON.parse(await fs.readFile(path.join(options.workspaceRoot, '.tools', name), 'utf8'));
  assert.deepEqual(Object.keys(content).sort(), ['key', 'mode']);
  assert.equal(content.mode, 'no-sandbox');
  assert.match(content.key, /^[a-f0-9]{64}$/);
  assert.equal(await rememberSandboxCompatibility(options, verified), true);
  assert.deepEqual(await files(), [name]);
});

test('compatibility is invalidated by Electron version, executable, profile, platform or checkout changes', async (t) => {
  const { options } = await setup(t);
  assert.equal(await rememberSandboxCompatibility(options, verified), true);
  for (const changed of [
    { electronVersion: '45.2.0' },
    { electronExecutable: 'C:\\other\\electron.exe' },
    { profile: 'C:\\work\\other-profile' },
    { platform: 'linux' as const },
    { workspaceRoot: path.join(options.workspaceRoot, 'other-checkout') },
  ])
    assert.deepEqual(await resolveDevelopmentSandbox({ ...options, ...changed }), normal);
  assert.equal(
    (
      await resolveDevelopmentSandbox({
        ...options,
        electronExecutable: options.electronExecutable.toUpperCase(),
        profile: options.profile.toUpperCase() + '\\',
      })
    ).source,
    'verified',
  );
});

test('normal closes, ordinary failures, timeouts and GPU recovery cannot create compatibility records', async (t) => {
  const { options, files } = await setup(t);
  for (const failedAttempt of [
    { code: 0, timedOut: false, log: '' },
    { code: 0, timedOut: false, log: crash },
    { code: 1, timedOut: false, log: fatal },
    { code: 0, timedOut: false, log: `${stamp} child-process-gone GPU crashed exit=1\n${fatal}` },
    { code: null, timedOut: true, log: `${crash}\n${fatal}` },
    { code: 0x80000003, timedOut: false, log: ready },
  ])
    assert.equal(await rememberSandboxCompatibility(options, { ...verified, failedAttempt }), false);
  for (const changed of [
    { recoveredLog: '' },
    { recoveredLog: `${stamp} renderer-console 1 window ready` },
    { recoveredLog: `${ready}\n${fatal}` },
    { softwareRendering: true },
    { sandboxDisabled: false },
  ])
    assert.equal(await rememberSandboxCompatibility(options, { ...verified, ...changed }), false);
  assert.deepEqual(await files(), []);
  for (const code of [0x80000003, -2147483645]) {
    assert.equal(
      await rememberSandboxCompatibility(options, {
        ...verified,
        failedAttempt: { code, timedOut: false, log: '' },
      }),
      true,
    );
  }
});

test('explicit sandbox modes override verified caches and required never permits a no-sandbox retry', async (t) => {
  const { options } = await setup(t);
  await rememberSandboxCompatibility(options, verified);
  for (const override of ['1', 'required', ' REQUIRED ']) {
    assert.deepEqual(await resolveDevelopmentSandbox({ ...options, override }), {
      mode: 'sandbox',
      canRetrySandbox: false,
      source: 'required',
    });
    assert.equal(await rememberSandboxCompatibility({ ...options, override }, verified), false);
  }
  for (const override of ['0', 'disabled']) {
    assert.deepEqual(await resolveDevelopmentSandbox({ ...options, override }), {
      mode: 'no-sandbox',
      canRetrySandbox: false,
      source: 'disabled',
    });
    assert.equal(await rememberSandboxCompatibility({ ...options, override }, verified), false);
  }
  await assert.rejects(resolveDevelopmentSandbox({ ...options, override: 'maybe' }), /BLODE_DEV_SANDBOX/);
  assert.equal((await resolveDevelopmentSandbox({ ...options, override: 'auto' })).source, 'verified');
});

test('damaged and oversized records are ignored and an atomic rewrite leaves no temporary files', async (t) => {
  const { options, files } = await setup(t);
  await rememberSandboxCompatibility(options, verified);
  const [name] = await files();
  const file = path.join(options.workspaceRoot, '.tools', name);
  const valid = await fs.readFile(file, 'utf8');
  for (const invalid of [
    '{',
    'null',
    JSON.stringify({ ...JSON.parse(valid), extra: true }),
    ' '.repeat(2048),
  ]) {
    await fs.writeFile(file, invalid);
    assert.deepEqual(await resolveDevelopmentSandbox(options), normal);
  }
  assert.equal(await rememberSandboxCompatibility(options, verified), true);
  assert.deepEqual(await files(), [name]);
  assert.equal(await fs.readFile(file, 'utf8'), valid);
});

test('non-Windows hosts neither create nor reuse compatibility records; console output is not readiness', async (t) => {
  const { options, files } = await setup(t);
  assert.equal(await rememberSandboxCompatibility({ ...options, platform: 'linux' }, verified), false);
  assert.deepEqual(await files(), []);
  assert.equal(hasReadyWindow(ready), true);
  assert.equal(hasReadyWindow(`${stamp} renderer-console 1 window ready`), false);
  assert.equal(hasReadyWindow(`${stamp} window first paint`), false);
  assert.equal(
    classifyElectronExit({
      code: 0x80000003,
      timedOut: false,
      log: `${stamp} renderer-console 1 window ready`,
    }).retry,
    'sandbox',
  );
});
