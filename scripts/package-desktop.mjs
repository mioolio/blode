import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreMediumIntegrity } from './windows-artifact-integrity.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
// Build in the system temp directory: Windows scanners can hold freshly written
// `.asar` archives inside the checkout, which blocks electron-builder's cleanup.
const staging = path.join(os.tmpdir(), 'blode-desktop-release-' + randomUUID());
const outputDirectory = path.join(staging, 'output');
const env = {
  ...process.env,
  BLODE_BUILD_MODE: 'production',
  ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '3',
  BLODE_RELEASE_DIST: path.join(staging, 'dist'),
  BLODE_NATIVE_STAGE_ROOT: path.join(staging, 'native'),
  BLODE_BUNDLE_TOOLS: process.argv.includes('--full') ? '1' : '0',
};
const sha256 = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const run = (script, args = []) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Packaging step failed (${code}): ${script}`)),
    );
  });

/**
 * A portable package that silently omits the renderer shows an empty window or
 * exits at once. Verify the archive before publishing the artifact.
 */
function verifyRendererArchive(directory) {
  const archive = path.join(directory, 'win-unpacked', 'resources', 'app.asar');
  let entries;
  try {
    entries = require('@electron/asar').listPackage(archive);
  } catch {
    return; // Non-asar layouts are checked by the Web build instead.
  }
  if (!entries.some((entry) => entry.replaceAll('\\', '/').endsWith('dist/renderer/index.html')))
    throw new Error('Desktop package is missing dist/renderer/index.html.');
}

try {
  console.log('Isolated release build: ' + env.BLODE_RELEASE_DIST);
  await run('node_modules/typescript/bin/tsc', ['--noEmit']);
  await run('scripts/build.mjs');
  await run('node_modules/vite/bin/vite.js', ['build']);
  await run('node_modules/electron-builder/cli.js', [
    '--config',
    'electron-builder.config.cjs',
    '--win',
    '--x64',
    '--publish',
    'never',
    `--config.directories.output=${outputDirectory}`,
  ]);
  verifyRendererArchive(outputDirectory);

  const { releaseVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const artifacts = (await readdir(outputDirectory)).filter((name) =>
    /^Blode\.Studio-.*\.(?:exe|zip)$/i.test(name),
  );
  if (artifacts.length === 0) throw new Error('electron-builder produced no release artifact.');
  const releaseDirectory = path.join(root, 'release', releaseVersion);
  await mkdir(releaseDirectory, { recursive: true });
  for (const name of artifacts) {
    const source = path.join(outputDirectory, name);
    const destination = path.join(releaseDirectory, name);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    if (name.toLowerCase().endsWith('.exe')) {
      // A checkout with a Low integrity label yields a low-token portable EXE
      // that cannot write its own user data, so repair the produced artifact.
      const result = await restoreMediumIntegrity(destination);
      console.log(`${result.applied ? 'Integrity: Medium' : 'Integrity: unchanged'} — ${name}`);
    }
    const digest = await sha256(destination);
    await writeFile(destination + '.sha256', `${digest}  ${name}\n`, { flag: 'wx' });
    console.log(`Desktop artifact: ${destination}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // Staging lives outside `release`; removal is best-effort because Windows
  // scanners can briefly lock freshly written archives.
  await rm(staging, { recursive: true, force: true }).catch(() => {});
}
