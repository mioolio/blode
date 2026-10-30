import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseFiles } from '../scripts/package-web';

const require = createRequire(import.meta.url);

test('release metadata keeps npm SemVer separate from the four-part Windows display version', () => {
  const metadata = require('../package.json');
  const config = require('../electron-builder.config.cjs');
  const { AppInfo } = require('app-builder-lib/out/appInfo');
  const version = require('semver');
  assert.equal(version.valid(metadata.version), metadata.version);
  assert.match(metadata.releaseVersion, /^\d+\.\d+\.\d+\.\d+$/);
  const parts = metadata.releaseVersion.split('.');
  assert.equal(metadata.version, `${parts.slice(0, 3).join('.')}-${parts[3]}`);
  const info = new AppInfo({ metadata: { ...metadata, ...config.extraMetadata }, config });
  assert.equal(info.buildVersion, metadata.releaseVersion);
  assert.equal(info.getVersionInWeirdWindowsForm(), metadata.releaseVersion);
  assert.equal(info.shortVersionWindows, metadata.releaseVersion);
  assert.ok(config.files.includes('config/application.json'));
  assert.ok(config.files.includes('!**/*.map'));
  assert.ok(!config.files.includes('dist/**/*'));
});

test('Web payload traversal omits source maps and refuses linked payload directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blode-release-payload-'));
  try {
    const payload = path.join(root, 'payload');
    const outside = path.join(root, 'outside');
    await mkdir(payload);
    await mkdir(outside);
    await writeFile(path.join(payload, 'app.js'), 'export const app = true;');
    await writeFile(path.join(payload, 'app.js.map'), 'private development source map');
    const names: string[] = [];
    for await (const entry of releaseFiles(payload, 'dist/renderer')) names.push(entry.path);
    assert.deepEqual(names, ['dist/renderer/app.js']);
    const link = path.join(payload, 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(async () => {
      for await (const _entry of releaseFiles(payload, 'dist/renderer')) {
        /* consume */
      }
    }, /symbolic links/);
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-release-payload-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin examples in a Web release exclude trust, credentials and developer directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blode-release-plugin-'));
  try {
    for (const name of [
      'manifest.json',
      'runtime/index.mjs',
      '.uel',
      '.env',
      '.env.local',
      '.vscode/settings.json',
      '.git/config',
      '.tools/profile.json',
      'node_modules/private.js',
    ]) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), 'fixture');
    }
    const names: string[] = [];
    for await (const file of releaseFiles(root, 'extensions/plugins/Example', true)) names.push(file.path);
    assert.deepEqual(names, [
      'extensions/plugins/Example/manifest.json',
      'extensions/plugins/Example/runtime/index.mjs',
    ]);
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
