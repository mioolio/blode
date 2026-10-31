import { promises as fs, constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { webReleasePayload } from './package-web';
import { BundledArchiveWriter } from '../src/core/archive-writer';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

/** Keep launcher flags separate from host flags, without requiring npm at runtime. */
export const nodeWebLauncher = `'use strict';
const path = require('node:path');
const release = require('./release.json');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log('Blode Studio Web ' + release.releaseVersion + ' (Node.js edition)');
} else if (Number(process.versions.node.split('.')[0]) < 24 || process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Node.js 24 or newer for Windows x64 is required.');
  process.exitCode = 1;
} else {
  const host = path.join(__dirname, 'dist', 'web-server.cjs');
  if (args.includes('--no-open') || args.includes('--help') || args.includes('-h')) {
    delete process.env.BLODE_WEB_OPEN_BROWSER;
  } else {
    process.env.BLODE_WEB_OPEN_BROWSER = '1';
  }
  process.argv = [process.execPath, host, ...args.filter(arg => arg !== '--no-open')];
  require(host);
}
`;

const startCommand = `@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer for Windows x64 is required.
  pause
  exit /b 1
)
node "%~dp0launch-web.cjs" %*
set "blodeExit=%errorlevel%"
if not "%blodeExit%"=="0" pause
exit /b %blodeExit%
`.replaceAll('\n', '\r\n');

export async function packageNodeWebRelease(options: { output?: string } = {}) {
  if (
    process.platform !== 'win32' ||
    process.arch !== 'x64' ||
    Number(process.versions.node.split('.')[0]) < 24
  )
    throw new Error('Build this distribution with Node.js 24 or newer for Windows x64.');
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const version: string = metadata.releaseVersion;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  const output = path.resolve(
    options.output ?? path.join(root, 'release', version, `Blode.Studio-${version}-web-node-win-x64.zip`),
  );
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-web-node-'));
  const dist = path.join(stage, 'dist');
  try {
    const built = await execute(process.execPath, [path.join(root, 'scripts', 'build-web.mjs')], {
      cwd: root,
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 10_000_000,
      env: { ...process.env, BLODE_RELEASE_DIST: dist },
    });
    process.stdout.write(built.stdout);
    process.stderr.write(built.stderr);
    const archive = path.join(stage, 'release.zip');
    const writer = new BundledArchiveWriter({
      root: path.join(root, 'vendor', '7zip'),
      dataRoot: path.join(stage, 'archive-runtime'),
    });
    const readme = `# Blode Studio ${version} · Web Node.js 版

运行环境：Windows x64，已安装 Node.js 24 或更高版本（x64）。

解压完整 ZIP，双击 start-web.cmd，或在命令行运行：

    node launch-web.cjs

启动后自动打开浏览器。项目和硬件由运行服务的这台电脑管理。

    node launch-web.cjs --no-open --host 0.0.0.0 --port 47821
    node launch-web.cjs --project "D:\\firmware\\my-project"
    node launch-web.cjs --help
    node launch-web.cjs --version

关闭命令窗口或按 Ctrl+C 结束服务。端口及目标机器访问方式见 --help。
不需要运行 npm install；ZIP 已包含宿主、网页资源、设备模块与 Windows x64 原生依赖。
编译工具通过首选项安装，或选择目标电脑上已有的工具目录。
`;
    await writer.write(
      archive,
      (async function* () {
        yield* webReleasePayload(dist, version, metadata.version, 'node-zip');
        yield { path: 'launch-web.cjs', data: Buffer.from(nodeWebLauncher) };
        yield { path: 'start-web.cmd', data: Buffer.from(startCommand) };
        yield { path: 'README.md', data: Buffer.from(readme) };
        yield {
          path: 'RELEASE-NOTES.md',
          data: await fs.readFile(path.join(root, 'docs', 'releases', `${version}.md`)),
        };
      })(),
      { onLine: (line) => console.log(line) },
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(archive, output, constants.COPYFILE_EXCL);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(output)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    await fs.writeFile(output + '.sha256', `${sha256}  ${path.basename(output)}\n`, { flag: 'wx' });
    const size = (await fs.stat(output)).size;
    console.log(`Web Node.js ZIP: ${output} (${(size / 1048576).toFixed(2)} MiB)`);
    return { path: output, size, sha256 };
  } finally {
    if (
      path.dirname(stage) === path.resolve(os.tmpdir()) &&
      path.basename(stage).startsWith('blode-web-node-')
    )
      await fs.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

if (/^package-web-node\.(?:ts|js|cjs|mjs)$/i.test(path.basename(process.argv[1] ?? ''))) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output'))
    throw new Error('Usage: npm run package:web:node -- [--output <new.zip>]');
  void packageNodeWebRelease({ output: args[1] }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
