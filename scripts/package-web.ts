import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeZip, type ZipEntry } from '../src/core/zip';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

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

async function npmCli(): Promise<string> {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates)
    if (candidate && (await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  throw new Error('npm CLI was not found. Run this command through npm run package:web.');
}

export async function packageWebRelease(options: { output?: string; skipBuild?: boolean } = {}) {
  if (!options.skipBuild) {
    const result = await execute(process.execPath, [path.join(root, 'scripts', 'build-web.mjs')], {
      cwd: root,
      timeout: 300_000,
      maxBuffer: 10_000_000,
      windowsHide: true,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  const sourcePackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const releaseVersion = sourcePackage.releaseVersion;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(releaseVersion))
    throw new Error('A four-part releaseVersion is required.');
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-web-release-'));
  const output = path.resolve(
    options.output ?? path.join(root, 'release', releaseVersion, `Blode.Studio-${releaseVersion}-web.zip`),
  );
  try {
    const manifest = {
      name: 'blode-studio-web',
      version: sourcePackage.version,
      releaseVersion,
      private: true,
      description: 'Blode Studio target-machine Web host without Electron',
      main: 'dist/web-server.cjs',
      scripts: { start: 'node dist/web-server.cjs' },
      engines: { node: '>=24' },
      dependencies: {
        serialport: sourcePackage.dependencies.serialport,
        'node-pty': sourcePackage.dependencies['node-pty'],
      },
      license: sourcePackage.license,
      repository: sourcePackage.repository,
    };
    await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    process.stdout.write('Preparing the native runtime lockfile (SerialPort and PTY; no install scripts).\n');
    await execute(
      process.execPath,
      [
        await npmCli(),
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
      ],
      {
        cwd: staging,
        timeout: 180_000,
        maxBuffer: 2_000_000,
        windowsHide: true,
      },
    );
    const lock = JSON.parse(await fs.readFile(path.join(staging, 'package-lock.json'), 'utf8'));
    if (
      Object.keys(lock.packages ?? {}).some((key) =>
        /(?:^|\/)node_modules\/(?:electron|@electron)(?:\/|$)/.test(key),
      )
    )
      throw new Error('Electron must not appear in the Web runtime lockfile.');
    const readme = `# Blode Studio Web ${releaseVersion}

简体中文说明见 docs/WEB-HOST.md；本次更新见 docs/releases/${releaseVersion}.md。

This edition runs a Node.js service on the computer that owns the projects and hardware. It does not contain Electron, Chromium, downloaded toolchains, project files or user credentials.

1. Install Node.js 24 or newer and extract this ZIP into a writable folder.
2. Run \`npm ci --omit=dev\` in that folder. SerialPort and node-pty provide the native device and interactive terminal runtimes.
3. Run \`npm start\` and open the private launch link printed once in the terminal.
4. To share within a trusted LAN, run \`npm start -- --host 0.0.0.0 --port 47821\`. Keep the launch token private.

The folder picker refers to directories on the service computer. Git credentials, compiler versions and USB permissions also belong to that computer. Press Ctrl+C to stop the service. See docs/WEB-HOST.md and docs/PLATFORM-SUPPORT.md for deployment and verification limits.

## Verification

The archive contains release-manifest.json with the SHA-256 and byte size of every payload file. A separate .zip.sha256 file verifies the ZIP itself. On Windows use Get-FileHash -Algorithm SHA256; on Linux use sha256sum. The public release is ${releaseVersion}; npm metadata uses ${sourcePackage.version} to satisfy Semantic Versioning requirements. Linux support has code-level adaptations and is not yet validated on physical Linux hardware.
`;
    await fs.writeFile(path.join(staging, 'README.md'), readme);
    await fs.mkdir(path.dirname(output), { recursive: true });
    async function* payload(): AsyncGenerator<ZipEntry> {
      const server = path.join(root, 'dist', 'web-server.cjs');
      const stat = await fs.lstat(server);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Build the Web host before packaging.');
      yield { path: 'dist/web-server.cjs', data: await fs.readFile(server) };
      yield* releaseFiles(path.join(root, 'dist', 'renderer'), 'dist/renderer');
      for (const name of ['package.json', 'package-lock.json', 'README.md'])
        yield { path: name, data: await fs.readFile(path.join(staging, name)) };
      yield* releaseFiles(path.join(root, 'docs'), 'docs');
      yield* releaseFiles(path.join(root, 'extensions', 'plugins'), 'extensions/plugins', true);
      for (const name of ['CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
        const file = path.join(root, name);
        if ((await fs.lstat(file).catch(() => null))?.isFile())
          yield { path: name, data: await fs.readFile(file) };
      }
      for (const name of ['manifest.json']) {
        const boards = path.join(root, 'extensions', 'boards');
        for (const entry of await fs.readdir(boards, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const file = path.join(boards, entry.name, name);
          const info = await fs.lstat(file).catch(() => null);
          if (info?.isFile() && !info.isSymbolicLink())
            yield { path: `boards/${entry.name}/${name}`, data: await fs.readFile(file) };
        }
      }
      const license = path.join(root, 'LICENSE');
      if ((await fs.lstat(license).catch(() => null))?.isFile())
        yield { path: 'LICENSE', data: await fs.readFile(license) };
    }
    async function* entries(): AsyncGenerator<ZipEntry> {
      const files: { path: string; bytes: number; sha256: string }[] = [];
      for await (const entry of payload()) {
        files.push({
          path: entry.path,
          bytes: entry.data.length,
          sha256: createHash('sha256').update(entry.data).digest('hex'),
        });
        yield entry;
      }
      yield {
        path: 'release-manifest.json',
        data: Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              product: 'Blode Studio',
              edition: 'web',
              releaseVersion,
              packageVersion: sourcePackage.version,
              node: '>=24',
              files,
            },
            null,
            2,
          ) + '\n',
        ),
      };
    }
    const temporaryArchive = path.join(path.dirname(output), `.${path.basename(output)}.${randomUUID()}.tmp`);
    try {
      const size = await writeZip(temporaryArchive, entries());
      // Never replace an existing release, including a file created during packaging.
      await fs.copyFile(temporaryArchive, output, constants.COPYFILE_EXCL);
      const sha256 = createHash('sha256')
        .update(await fs.readFile(output))
        .digest('hex');
      await fs.writeFile(output + '.sha256', `${sha256}  ${path.basename(output)}\n`, { flag: 'wx' });
      process.stdout.write(`Web ZIP: ${output} (${(size / 1048576).toFixed(2)} MiB)\n`);
      return { path: output, size, sha256 };
    } finally {
      await fs.unlink(temporaryArchive).catch(() => {});
    }
  } finally {
    const checked = path.resolve(staging);
    const allowed = path.resolve(os.tmpdir());
    if (path.dirname(checked) !== allowed || !path.basename(checked).startsWith('blode-web-release-'))
      throw new Error('Refusing to remove an unexpected staging directory.');
    await fs.rm(checked, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: npm run package:web -- [--output <new.zip>] [--skip-build]\n');
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
