import { constants, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeZip, type ZipEntry } from '../src/core/zip';
import { restoreMediumIntegrity } from './windows-artifact-integrity.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const TARGET_PREBUILDS = 'win32-x64';
const NATIVE_PACKAGES = ['serialport', 'node-pty'];

/** Walk only an explicit renderer/staging tree; never follow a link into host data. */
export async function* releaseFiles(
  directory: string,
  prefix: string,
  plugin = false,
): AsyncGenerator<ZipEntry> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe release directory: ${directory}`);
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name.endsWith('.map')) continue;
    if (
      plugin &&
      (['.uel', '.vscode', '.git', '.tools', 'node_modules'].includes(entry.name) ||
        /^\.env(?:\.|$)/i.test(entry.name))
    )
      continue;
    const file = path.join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Release cannot contain symbolic links: ${relative}`);
    if (entry.isDirectory()) yield* releaseFiles(file, relative, plugin);
    else if (entry.isFile()) {
      const stat = await fs.stat(file);
      if (stat.size > 100_000_000) throw new Error(`Unexpected large release file: ${relative}`);
      yield { path: relative, data: await fs.readFile(file) };
    }
  }
}

/** Locate an installed package directory from a requiring package's folder. */
function locatePackage(name: string, fromDirectory: string): string {
  const local = createRequire(path.join(fromDirectory, 'package.json'));
  let resolved: string;
  try {
    resolved = local.resolve(`${name}/package.json`);
  } catch {
    resolved = local.resolve(name);
  }
  let directory = path.dirname(resolved);
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === name) return directory;
    } catch {
      /* Keep walking until the package root is found. */
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Package directory not found: ${name}`);
    directory = parent;
  }
}

/**
 * SerialPort and node-pty depend on native binaries. Their full production
 * closure is discovered through Node's own resolution rules so nested
 * `node_modules` layouts keep working after extraction.
 */
function runtimePackages(): Map<string, string> {
  const packages = new Map<string, string>();
  const visit = (directory: string): void => {
    const real = path.resolve(directory);
    if (packages.has(real)) return;
    const manifest = JSON.parse(readFileSync(path.join(real, 'package.json'), 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    packages.set(real, manifest.name ?? path.basename(real));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }))
      try {
        visit(locatePackage(dependency, real));
      } catch {
        /* Optional/native dependency absent for this target. */
      }
  };
  for (const name of NATIVE_PACKAGES) visit(locatePackage(name, root));
  return packages;
}

/**
 * Keep only runtime files for the packaged platform. Electron-only rebuilds,
 * foreign prebuilds and debug symbols are omitted; the Node-ABI prebuilds that
 * remain are the ones `node-gyp-build`/node-pty load at runtime.
 */
function includePackageFile(packageName: string, relative: string): boolean {
  const parts = relative.split('/');
  if (parts.includes('node_modules')) return false;
  if (parts[0] === 'prebuilds' && parts.length > 2 && parts[1] !== TARGET_PREBUILDS) return false;
  if (packageName === 'node-pty' && parts[0] === 'build') return false;
  // Native packages ship compiler inputs next to their prebuilds; the runtime
  // only needs the JavaScript wrapper and the matching `.node` binaries.
  if (
    ['node-pty', '@serialport/bindings-cpp'].includes(packageName) &&
    ['src', 'third_party', 'scripts', 'binding.gyp'].includes(parts[0])
  )
    return false;
  const base = parts[parts.length - 1];
  if (base.endsWith('.pdb') || base.endsWith('.map')) return false;
  return !['.github', 'test', 'tests', '__tests__', 'docs', 'example', 'examples'].includes(parts[0]);
}

async function* walkFiles(directory: string): AsyncGenerator<string> {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release cannot contain symbolic links: ${file}`);
    if (entry.isDirectory()) yield* walkFiles(file);
    else if (entry.isFile()) yield file;
  }
}

function zipName(file: string): string {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative))
    throw new Error(`Release file escapes the repository: ${file}`);
  return relative;
}

async function* payload(
  distDirectory: string,
  releaseVersion: string,
  packageVersion: string,
): AsyncGenerator<ZipEntry> {
  yield {
    path: 'release.json',
    data: Buffer.from(
      JSON.stringify(
        {
          product: 'Blode Studio',
          edition: 'web',
          format: 'exe',
          releaseVersion,
          packageVersion,
          platform: 'win32',
          arch: 'x64',
          node: process.version,
        },
        null,
        2,
      ) + '\n',
    ),
  };
  const license = path.join(root, 'LICENSE');
  if ((await fs.lstat(license).catch(() => null))?.isFile())
    yield { path: 'LICENSE', data: await fs.readFile(license) };
  yield { path: 'dist/web-server.cjs', data: await fs.readFile(path.join(distDirectory, 'web-server.cjs')) };
  yield* releaseFiles(path.join(distDirectory, 'renderer'), 'dist/renderer');
  yield* releaseFiles(path.join(distDirectory, 'device-modules'), 'dist/device-modules', true);
  yield* releaseFiles(path.join(distDirectory, 'archive-tools'), 'dist/archive-tools');
  yield* releaseFiles(path.join(root, 'extensions', 'plugins'), 'extensions/plugins', true);
  const boards = path.join(root, 'extensions', 'boards');
  for (const entry of await fs.readdir(boards, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const manifest = path.join(boards, entry.name, 'manifest.json');
    if ((await fs.lstat(manifest).catch(() => null))?.isFile())
      yield {
        path: `extensions/boards/${entry.name}/manifest.json`,
        data: await fs.readFile(manifest),
      };
  }
  for (const [directory, name] of runtimePackages())
    for await (const file of walkFiles(directory)) {
      const relative = path.relative(directory, file).split(path.sep).join('/');
      if (!includePackageFile(name, relative)) continue;
      yield { path: zipName(file), data: await fs.readFile(file) };
    }
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

export async function packageWebRelease(options: { output?: string; skipBuild?: boolean } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('The Web executable is built on Windows x64; other targets need their own Node runtime.');
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Node.js 24 or newer is required to build the Web executable.');
  if (path.basename(process.execPath).toLowerCase() !== 'node.exe')
    throw new Error('Run package:web with the official Node.js 24 Windows runtime (node.exe).');
  const sourcePackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
    releaseVersion?: string;
  };
  const releaseVersion = sourcePackage.releaseVersion ?? '';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(releaseVersion))
    throw new Error('A four-part releaseVersion is required.');
  const output = path.resolve(
    options.output ??
      path.join(root, 'release', releaseVersion, `Blode.Studio-${releaseVersion}-web-win-x64.exe`),
  );
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-web-exe-'));
  const distDirectory = options.skipBuild ? path.join(root, 'dist') : path.join(staging, 'dist');
  try {
    if (!options.skipBuild) {
      const result = await execute(process.execPath, [path.join(root, 'scripts', 'build-web.mjs')], {
        cwd: root,
        timeout: 300_000,
        maxBuffer: 10_000_000,
        windowsHide: true,
        env: { ...process.env, BLODE_RELEASE_DIST: distDirectory },
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    if ((await fs.lstat(path.join(distDirectory, 'web-server.cjs')).catch(() => null))?.isFile() !== true)
      throw new Error('Build the Web host before packaging.');

    const bundle = path.join(staging, 'bundle.zip');
    const bundleSize = await writeZip(bundle, payload(distDirectory, releaseVersion, sourcePackage.version));
    process.stdout.write(`Runtime payload: ${(bundleSize / 1048576).toFixed(2)} MiB compressed.\n`);

    const bootstrap = path.join(staging, 'web-bootstrap.cjs');
    await build({
      absWorkingDir: root,
      entryPoints: ['scripts/web-bootstrap.ts'],
      outfile: bootstrap,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      minify: true,
      keepNames: false,
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'warning',
      define: { __BLODE_RELEASE_VERSION__: JSON.stringify(releaseVersion) },
    });

    const blob = path.join(staging, 'sea-prep.blob');
    const seaConfig = path.join(staging, 'sea-config.json');
    await fs.writeFile(
      seaConfig,
      JSON.stringify(
        {
          main: bootstrap,
          output: blob,
          assets: { 'bundle.zip': bundle },
          disableExperimentalSEAWarning: true,
        },
        null,
        2,
      ),
    );
    await execute(process.execPath, ['--experimental-sea-config', seaConfig], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 10_000_000,
      windowsHide: true,
    });

    const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
    if ((await fs.lstat(postject).catch(() => null))?.isFile() !== true)
      throw new Error('postject is missing; run npm ci before packaging the Web executable.');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(process.execPath, output, constants.COPYFILE_EXCL);
    await execute(process.execPath, [postject, output, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE], {
      cwd: root,
      timeout: 180_000,
      maxBuffer: 10_000_000,
      windowsHide: true,
    });

    const integrity = await restoreMediumIntegrity(output);
    if (!integrity.applied)
      process.stdout.write(
        `Warning: could not reset the executable integrity label (${integrity.reason}).\n`,
      );

    const smoke = await execute(output, ['--version'], { timeout: 60_000, windowsHide: true });
    if (!smoke.stdout.includes(releaseVersion))
      throw new Error('The packaged Web executable did not report its release version.');
    const size = (await fs.stat(output)).size;
    const sha256 = await sha256File(output);
    await fs.writeFile(output + '.sha256', `${sha256}  ${path.basename(output)}\n`, { flag: 'wx' });
    process.stdout.write(`Web EXE: ${output} (${(size / 1048576).toFixed(2)} MiB)\n`);
    return { path: output, size, sha256 };
  } finally {
    const checked = path.resolve(staging);
    const allowed = path.resolve(os.tmpdir());
    if (path.dirname(checked) !== allowed || !path.basename(checked).startsWith('blode-web-exe-'))
      throw new Error('Refusing to remove an unexpected staging directory.');
    if (process.env.BLODE_WEB_KEEP_STAGING === '1') process.stdout.write(`Staging kept: ${checked}\n`);
    else await fs.rm(checked, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: npm run package:web -- [--output <new.exe>] [--skip-build]\n' +
        'Builds one self-contained Windows x64 Web executable (Node SEA, no Electron).\n',
    );
    return;
  }
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--skip-build') continue;
    if (args[index] !== '--output' || !args[index + 1]) throw new Error(`Invalid option: ${args[index]}`);
    output = args[++index];
  }
  await packageWebRelease({ output, skipBuild: args.includes('--skip-build') });
}

if (/^package-web\.(?:ts|js|cjs|mjs)$/i.test(path.basename(process.argv[1] ?? '')))
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
