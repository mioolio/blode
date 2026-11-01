import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { restoreMediumIntegrity } from './windows-artifact-integrity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const destination = path.join(root, 'release', metadata.releaseVersion);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-installers-'));
const run = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Installer step failed (${code}): ${args[0]}`)),
    );
  });
try {
  await fs.mkdir(destination, { recursive: true });
  for (const protectedBuild of process.argv.includes('--protected-only') ? [true] : [false, true]) {
    const label = protectedBuild ? 'protected' : 'standard';
    const stage = path.join(temp, label);
    const application = path.join(stage, 'application');
    if (protectedBuild) {
      await fs.mkdir(application, { recursive: true });
      await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({
        name: metadata.name, productName: metadata.productName, version: metadata.version,
        releaseVersion: metadata.releaseVersion, main: metadata.main, type: 'module',
        author: { name: 'Blode Studio' }, description: 'Blode Studio Commercial Distribution',
        license: 'Proprietary', distribution: 'commercial-protected', dependencies: metadata.dependencies,
      }, null, 2) + '\n');
    }
    const env = {
      BLODE_BUILD_MODE: 'production',
      BLODE_PROTECTED: protectedBuild ? '1' : '0',
      BLODE_RELEASE_DIST: path.join(stage, 'dist'),
      BLODE_NATIVE_STAGE_ROOT: path.join(stage, 'native'),
      ...(protectedBuild ? { BLODE_APPLICATION_ROOT: application } : {}),
    };
    await run(['scripts/build.mjs'], env);
    await run(['node_modules/vite/bin/vite.js', 'build'], env);
    await run(
      [
        'node_modules/electron-builder/cli.js',
        '--config',
        'electron-installer.config.cjs',
        '--win',
        '--x64',
        '--publish',
        'never',
        `--config.directories.output=${path.join(stage, 'output')}`,
      ],
      env,
    );
    const artifacts = (await fs.readdir(path.join(stage, 'output'))).filter((file) => file.endsWith('.exe'));
    if (artifacts.length !== 1) throw new Error('Expected exactly one installer.');
    for (const name of artifacts) {
      const file = path.join(destination, name);
      await fs.copyFile(path.join(stage, 'output', name), file, fs.constants.COPYFILE_EXCL);
      await restoreMediumIntegrity(file);
      await run(['--import', 'tsx', 'scripts/sign-release.ts', file, metadata.releaseVersion], env);
      const hash = createHash('sha256');
      for await (const chunk of (await import('node:fs')).createReadStream(file)) hash.update(chunk);
      await fs.writeFile(file + '.sha256', `${hash.digest('hex')}  ${name}\n`);
      console.log(`Installer ready: ${file}`);
    }
  }
} finally {
  // temp is exclusively created for this run, outside the user's project.
  if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('blode-installers-'))
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
