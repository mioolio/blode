import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const staging = path.join(root, '.tools', 'release-builds', randomUUID());
const env = {
  ...process.env,
  BLODE_BUILD_MODE: 'production',
  ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '3',
  BLODE_RELEASE_DIST: path.join(staging, 'dist'),
  BLODE_NATIVE_STAGE_ROOT: path.join(staging, 'native'),
  BLODE_BUNDLE_TOOLS: process.argv.includes('--full') ? '1' : '0',
};
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
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
