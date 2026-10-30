import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createPackageIntegrityHooks } = require('../scripts/windows-package-integrity.cjs');

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-package-integrity-'));
  const project = path.join(base, 'project'),
    output = path.join(base, 'release', '0.3.4.2');
  const app = path.join(output, 'win-unpacked');
  await fs.mkdir(project);
  await fs.mkdir(app, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('blode-package-integrity-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const calls: string[][] = [];
  const repair = async (files: string[]) => {
    calls.push(files);
    return { files: files.map((file) => ({ path: file, before: 4096, after: 8192, repaired: true })) };
  };
  const hooks = createPackageIntegrityHooks({ platform: 'win32', projectDir: project, repair, log() {} });
  const context = {
    outDir: output,
    appOutDir: app,
    electronPlatformName: 'win32',
    packager: { projectDir: project },
  };
  const artifact = path.join(output, 'Blode.Studio-0.3.4.2-desktop-win-x64.exe');
  const write = async (file: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'mock executable');
    return file;
  };
  return { base, project, output, app, artifact, calls, repair, hooks, context, write };
}

test('afterPack repairs ordinary unpacked executables including nested helpers, without scanning sibling releases', async (t) => {
  const f = await fixture(t),
    executable = await f.write(path.join(f.app, 'Blode Studio.exe'));
  const helper = await f.write(
    path.join(f.app, 'resources/app.asar.unpacked/node_modules/node-pty/helper.EXE'),
  );
  await f.write(path.join(f.app, 'resources/readme.txt'));
  await f.write(path.join(f.output, 'older-unpacked/Blode Studio.exe'));
  await f.write(f.artifact);
  assert.equal(await f.hooks.afterPack(f.context), undefined);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(new Set(f.calls[0]), new Set([executable, helper]));
});

test('afterAllArtifactBuild repairs only listed project EXEs and returns no additional artifacts', async (t) => {
  const f = await fixture(t);
  await f.write(f.artifact);
  const stale = await f.write(path.join(f.output, 'Blode.Studio-0.2.3.6-desktop-win-x64.exe'));
  const foreign = await f.write(path.join(f.output, 'ThirdParty.exe'));
  const context = {
    outDir: f.output,
    artifactPaths: [f.artifact, f.artifact, foreign, path.join(f.output, 'not-created.zip')],
    platformToTargets: new Map([[{ nodeName: 'win32' }, new Map()]]),
  };
  assert.deepEqual(await f.hooks.afterAllArtifactBuild(context), []);
  assert.deepEqual(f.calls, [[f.artifact]]);
  assert.ok(!f.calls.flat().includes(stale));
});

test('Linux hosts and non-Windows targets do not inspect paths or invoke the Windows helper', async () => {
  let repairs = 0;
  const hooks = createPackageIntegrityHooks({
    platform: 'linux',
    repair() {
      repairs++;
      throw Error('unexpected repair');
    },
  });
  assert.equal(await hooks.afterPack({}), undefined);
  assert.deepEqual(
    await hooks.afterAllArtifactBuild({
      artifactPaths: ['/missing/Blode.Studio-0.3.4.2-desktop-win-x64.exe'],
    }),
    [],
  );
  const windows = createPackageIntegrityHooks({
    platform: 'win32',
    repair() {
      repairs++;
      throw Error('unexpected repair');
    },
  });
  assert.equal(await windows.afterPack({ electronPlatformName: 'linux' }), undefined);
  assert.deepEqual(
    await windows.afterAllArtifactBuild({
      artifactPaths: ['/missing/Blode.Studio-0.3.4.2-desktop-win-x64.exe'],
      platformToTargets: new Map([[{ nodeName: 'linux' }, new Map()]]),
    }),
    [],
  );
  assert.equal(repairs, 0);
});

test('output containment rejects sibling paths and roots before repairing any files', async (t) => {
  const f = await fixture(t);
  await f.write(f.artifact);
  const outside = await f.write(path.join(f.base, 'elsewhere/Blode.Studio-0.3.4.2-desktop-win-x64.exe'));
  await assert.rejects(
    f.hooks.afterAllArtifactBuild({ outDir: f.output, artifactPaths: [f.artifact, outside] }),
    /outside the build output/,
  );
  await assert.rejects(
    f.hooks.afterPack({ ...f.context, appOutDir: path.dirname(outside) }),
    /outside the build output/,
  );
  await assert.rejects(
    f.hooks.afterPack({ ...f.context, outDir: f.project, appOutDir: f.project }),
    /project root or its parent/,
  );
  await assert.rejects(f.hooks.afterPack({ ...f.context, outDir: f.base }), /project root or its parent/);
  await assert.rejects(
    f.hooks.afterPack({ ...f.context, outDir: path.parse(f.base).root }),
    /project root or its parent/,
  );
  await assert.rejects(f.hooks.afterPack({ ...f.context, outDir: '.' }), /absolute build output/);
  assert.equal(f.calls.length, 0);
});

test('configured output is supported when the hook has no explicit outDir', async (t) => {
  const f = await fixture(t);
  await f.write(f.artifact);
  const configuration = { directories: { output: path.relative(f.project, f.output) } };
  assert.deepEqual(await f.hooks.afterAllArtifactBuild({ configuration, artifactPaths: [f.artifact] }), []);
  assert.deepEqual(f.calls, [[f.artifact]]);
});

test('linked artifact paths and linked app roots are rejected, nested directory links are never followed', async (t) => {
  const f = await fixture(t),
    outside = path.join(f.base, 'external');
  const foreign = await f.write(path.join(outside, 'outside.exe'));
  await f.write(path.join(f.app, 'Blode Studio.exe'));
  const link = path.join(f.output, 'linked-app');
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return t.skip('host denies test symlinks');
    throw error;
  }
  await assert.rejects(f.hooks.afterPack({ ...f.context, appOutDir: link }), /linked path/);
  const linkedArtifact = path.join(link, 'outside.exe');
  await assert.rejects(
    f.hooks.afterAllArtifactBuild({ outDir: f.output, artifactPaths: [linkedArtifact] }),
    /linked path/,
  );
  await fs.symlink(
    outside,
    path.join(f.app, 'external-tools'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await f.hooks.afterPack(f.context);
  assert.deepEqual(f.calls, [[path.join(f.app, 'Blode Studio.exe')]]);
  assert.ok(!f.calls.flat().includes(foreign));
  const outputLink = path.join(f.base, 'output-link');
  await fs.symlink(f.output, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    f.hooks.afterAllArtifactBuild({
      outDir: outputLink,
      artifactPaths: [path.join(outputLink, path.basename(f.artifact))],
    }),
    /linked path/,
  );
});

test('incomplete/failed integrity verification fails the hook instead of packaging a known Low executable', async (t) => {
  const f = await fixture(t);
  await f.write(f.artifact);
  for (const report of [{ files: [] }, { files: [{ after: 4096 }] }, { files: [{}] }]) {
    const hooks = createPackageIntegrityHooks({
      platform: 'win32',
      projectDir: f.project,
      repair: async () => report,
      log() {},
    });
    await assert.rejects(
      hooks.afterAllArtifactBuild({ outDir: f.output, artifactPaths: [f.artifact] }),
      /did not restore all executables/,
    );
  }
});

test('electron-builder exposes both hooks as functions with the expected hook return shape', () => {
  const config = require('../electron-builder.config.cjs');
  assert.equal(typeof config.afterPack, 'function');
  assert.equal(typeof config.afterAllArtifactBuild, 'function');
});
