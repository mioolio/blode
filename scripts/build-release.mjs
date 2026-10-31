import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function releaseVersions(input) {
  const releaseVersion = input.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseVersion))
    throw Error('请输入四段版本号，例如 0.3.5.9。');
  const parts = releaseVersion.split('.');
  if (parts.some((part) => Number(part) > 65535)) throw Error('每段版本号不能超过 65535。');
  return { releaseVersion, version: `${parts.slice(0, 3).join('.')}-${parts[3]}` };
}

export function releaseNotes(version, changelog, date) {
  const changes = /^## 未发布\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(changelog)?.[1].trim();
  return `# Blode Studio ${version}

发布日期：${date}

## 更新内容

${changes || '维护更新。详细变更见 CHANGELOG.md。'}

## 下载与运行

| 版本 | 文件 | 运行要求 |
| --- | --- | --- |
| 桌面便携版 | \`Blode.Studio-${version}-desktop-win-x64.exe\` | Windows x64，直接运行 |
| Web 独立版 | \`Blode.Studio-${version}-web-win-x64.exe\` | Windows x64，运行后在浏览器使用，无需安装 Node.js |
| Web Node.js 版 | \`Blode.Studio-${version}-web-node-win-x64.zip\` | Windows x64、Node.js 24+ x64；解压后运行 \`start-web.cmd\` |

Web 版在项目和硬件所在电脑启动服务。Node.js ZIP 已包含依赖，无需 npm install。编译工具在首选项中安装，或选择本机已有工具。

三个发行包均提供 SHA-256 校验文件。本次未构建 Linux、macOS 发行包。
`;
}

async function writeJson(file, value) {
  const original = await fs.readFile(file, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  await fs.writeFile(file, (JSON.stringify(value, null, 2) + '\n').replaceAll('\n', newline));
}

async function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await fs.unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error(`无效的构建锁：${file}`);
      try {
        process.kill(pid, 0);
      } catch (failure) {
        if (failure.code === 'ESRCH') {
          await fs.unlink(file);
          continue;
        }
        throw failure;
      }
      throw Error('已有发行构建正在运行，请等待它完成。');
    }
  }
  throw Error('无法获取发行构建锁。');
}

export async function buildRelease(input) {
  const versions = releaseVersions(input);
  if (
    process.platform !== 'win32' ||
    process.arch !== 'x64' ||
    Number(process.versions.node.split('.')[0]) < 24
  )
    throw Error('请使用 Windows x64 和 Node.js 24 或更高版本。');
  const output = path.join(root, 'release', versions.releaseVersion);
  const names = [
    `Blode.Studio-${versions.releaseVersion}-desktop-win-x64.exe`,
    `Blode.Studio-${versions.releaseVersion}-web-win-x64.exe`,
    `Blode.Studio-${versions.releaseVersion}-web-node-win-x64.zip`,
  ];
  await fs.mkdir(path.join(root, '.tools'), { recursive: true });
  const unlock = await acquireLock(path.join(root, '.tools', 'release-build.lock'));
  let log;
  try {
    for (const name of names)
      if (await fs.lstat(path.join(output, name)).catch(() => null))
        throw Error(`发行包已存在，请先移走旧文件或使用新版本号：${path.join(output, name)}`);
    const logFile = path.join(root, '.tools', `release-${versions.releaseVersion}-${Date.now()}.log`);
    log = createWriteStream(logFile);
    const say = (message) => {
      console.log(message);
      log.write(message + '\n');
    };
    const run = (args, command) =>
      new Promise((resolve, reject) => {
        const child = spawn(command || process.execPath, args, {
          cwd: root,
          stdio: ['inherit', 'pipe', 'pipe'],
          windowsHide: true,
        });
        child.stdout.on('data', (chunk) => {
          process.stdout.write(chunk);
          log.write(chunk);
        });
        child.stderr.on('data', (chunk) => {
          process.stderr.write(chunk);
          log.write(chunk);
        });
        child.once('error', reject);
        child.once('close', (code, signal) =>
          code === 0 ? resolve() : reject(Error(`构建步骤失败 (${signal || code})：${args.join(' ')}`)),
        );
      });
    say(`Blode Studio ${versions.releaseVersion} · 三种发行包\n日志：${logFile}`);
    const dependencies = [
      'typescript/bin/tsc',
      'tsx/dist/loader.mjs',
      'vite/bin/vite.js',
      'electron-builder/cli.js',
      'postject/dist/cli.js',
    ];
    if (
      (
        await Promise.all(
          dependencies.map((file) => fs.stat(path.join(root, 'node_modules', file)).catch(() => null)),
        )
      ).some((value) => !value)
    ) {
      say('正在安装构建依赖……');
      await run(['/d', '/s', '/c', 'npm ci'], process.env.ComSpec || 'cmd.exe');
    }
    const packageFile = path.join(root, 'package.json');
    const lockFile = path.join(root, 'package-lock.json');
    const metadata = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    Object.assign(metadata, versions);
    lock.version = versions.version;
    lock.packages[''].version = versions.version;
    await writeJson(packageFile, metadata);
    await writeJson(lockFile, lock);
    const notes = path.join(root, 'docs', 'releases', versions.releaseVersion + '.md');
    await fs.mkdir(path.dirname(notes), { recursive: true });
    if (!(await fs.stat(notes).catch(() => null))) {
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
      await fs.writeFile(
        notes,
        releaseNotes(
          versions.releaseVersion,
          await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
          date,
        ),
        { flag: 'wx' },
      );
    }
    for (const [index, args] of [
      ['scripts/package-desktop.mjs'],
      ['--import', 'tsx', 'scripts/package-web.ts'],
      ['--import', 'tsx', 'scripts/package-web-node.ts'],
    ].entries()) {
      say(`\n[${index + 1}/3] ${['桌面便携版', 'Web 独立版', 'Web Node.js ZIP'][index]}：开始`);
      await run(args);
    }
    const files = [];
    for (const name of names) {
      const file = path.join(output, name);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      if ((await fs.readFile(file + '.sha256', 'utf8')).split(/\s/)[0] !== sha256)
        throw Error(`发行包校验失败：${name}`);
      files.push({ name, bytes: (await fs.stat(file)).size, sha256 });
    }
    await fs.copyFile(notes, path.join(output, 'RELEASE-NOTES.md'));
    await fs.writeFile(
      path.join(output, 'SHA256SUMS'),
      files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
    );
    await fs.writeFile(
      path.join(output, 'release-manifest.json'),
      JSON.stringify({ ...versions, builtAt: new Date().toISOString(), files }, null, 2) + '\n',
    );
    say(`\n构建完成：${output}\n发行说明：${path.join(output, 'RELEASE-NOTES.md')}`);
    for (const file of files) say(`${file.name}  ${(file.bytes / 1048576).toFixed(2)} MiB`);
    return { directory: output, files };
  } finally {
    if (log) await new Promise((resolve) => log.end(resolve));
    await unlock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let version = process.argv[2];
    if (process.argv.length > 3) throw Error('用法：build-release.bat [0.3.5.9]');
    if (!version) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        version = await prompt.question('请输入发行版本号（例如 0.3.5.9）：');
      } finally {
        prompt.close();
      }
    }
    await buildRelease(version);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
