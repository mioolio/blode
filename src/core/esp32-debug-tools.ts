import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { InstallationProgress, ProjectConfig } from '../shared/contracts';
import { runCommand } from './process';

export interface Esp32DebugTools {
  gdb: string | null;
  openocd: string | null;
  scripts: string | null;
}
interface DiscoveryOptions {
  root: string;
  dataRoot: string;
  config?: ProjectConfig;
  gdbPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
const fileExists = async (file: string) => (await fs.stat(file).catch(() => null))?.isFile() === true;
const hasEsp32Scripts = async (directory: string) =>
  (await fileExists(path.join(directory, 'board', 'esp32s3-builtin.cfg'))) &&
  (await fileExists(path.join(directory, 'target', 'esp32s3.cfg')));
const absolute = (value: string | undefined): value is string =>
  !!value && path.isAbsolute(value) && !/[\r\n\0]/.test(value);
async function children(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
    .slice(0, 64)
    .map((entry) => path.join(directory, entry.name));
}
const GDB_NAMES = ['xtensa-esp-elf-gdb-no-python', 'xtensa-esp-elf-gdb', 'xtensa-esp32s3-elf-gdb'] as const;

/** Bounded local discovery; never scans drives or starts a debugger. */
export async function discoverEsp32DebugTools(options: DiscoveryOptions): Promise<Esp32DebugTools> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const suffix = platform === 'win32' ? '.exe' : '';
  const config = options.config?.debugger;
  const root = path.resolve(options.root),
    dataRoot = path.resolve(options.dataRoot);
  const home = env.USERPROFILE || env.HOME;
  const paths = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(absolute);
  const arduinoStores = [
    options.config?.toolchain.packageDirectory,
    root,
    ...(await children(path.join(root, 'versions', 'arduino-esp32'))),
  ]
    .filter(absolute)
    .map((store) => path.join(store, 'arduino-data'));
  if (absolute(env.ARDUINO_DIRECTORIES_DATA)) arduinoStores.unshift(env.ARDUINO_DIRECTORIES_DATA);
  if (platform === 'win32' && absolute(env.LOCALAPPDATA))
    arduinoStores.push(path.join(env.LOCALAPPDATA, 'Arduino15'));
  else if (absolute(home))
    arduinoStores.push(path.join(home, platform === 'darwin' ? 'Library/Arduino15' : '.arduino15'));
  const roots = [root, path.join(root, 'esp32-debug'), path.join(dataRoot, 'esp32-debug')];
  if (absolute(env.IDF_TOOLS_PATH)) roots.push(path.join(env.IDF_TOOLS_PATH, 'tools'));
  else if (absolute(home)) roots.push(path.join(home, '.espressif', 'tools'));
  for (const store of arduinoStores) roots.push(path.join(store, 'packages', 'esp32', 'tools'));
  const gdbDirs: string[] = [],
    openocdDirs: string[] = [];
  for (const base of new Set(roots)) {
    for (const [names, destinations] of [
      [['xtensa-esp-elf-gdb', 'xtensa-esp32s3-elf', 'esp-xs3'], gdbDirs],
      [['openocd-esp32', 'openocd'], openocdDirs],
    ] as const) {
      for (const name of names) {
        const directory = path.join(base, name);
        const versions = await children(directory);
        for (const candidate of [directory, ...versions]) {
          destinations.push(path.join(candidate, 'bin'), candidate, path.join(candidate, name, 'bin'));
        }
      }
    }
  }
  gdbDirs.push(...paths);
  openocdDirs.push(...paths);
  const configuredGdb = config?.gdbPath || options.gdbPath;
  let gdb: string | null = null;
  if (configuredGdb)
    gdb = absolute(configuredGdb) && (await fileExists(configuredGdb)) ? configuredGdb : null;
  else
    for (const directory of new Set(gdbDirs)) {
      for (const name of GDB_NAMES) {
        const candidate = path.join(directory, name + suffix);
        if (await fileExists(candidate)) {
          gdb = candidate;
          break;
        }
      }
      if (gdb) break;
    }
  const scriptsAt = async (directory: string | undefined): Promise<string | null> => {
    if (!absolute(directory)) return null;
    return (await hasEsp32Scripts(directory)) ? directory : null;
  };
  const scriptsFor = async (executable: string) => {
    if (config?.scriptsPath) return scriptsAt(config.scriptsPath);
    const bin = path.dirname(executable);
    for (const directory of [
      env.OPENOCD_SCRIPTS,
      path.join(bin, '..', 'share', 'openocd', 'scripts'),
      path.join(bin, '..', 'scripts'),
    ]) {
      const found = await scriptsAt(directory);
      if (found) return path.resolve(found);
    }
    return null;
  };
  let openocd: string | null = null,
    scripts: string | null = null;
  const candidates = config?.serverPath
    ? [config.serverPath]
    : [...new Set(openocdDirs)].map((directory) => path.join(directory, 'openocd' + suffix));
  for (const candidate of candidates) {
    if (!absolute(candidate) || !(await fileExists(candidate))) continue;
    const foundScripts = await scriptsFor(candidate);
    if (!openocd) openocd = candidate;
    if (foundScripts) {
      openocd = candidate;
      scripts = foundScripts;
      break;
    }
  }
  return { gdb, openocd, scripts };
}

export interface Esp32DebugRelease {
  kind: 'xtensa-esp-elf-gdb' | 'openocd-esp32';
  version: string;
  url: string;
  sha256: string;
  size: number;
}
export const ESP32_DEBUG_CATALOG_SOURCE =
  'https://raw.githubusercontent.com/espressif/esp-idf/v5.5.1/tools/tools.json';
/** Publisher checksums pinned to ESP-IDF v5.5.1, rather than an unversioned latest download. */
export function esp32DebugReleases(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): Esp32DebugRelease[] {
  const target =
    platform === 'win32' && arch === 'x64'
      ? 'win64'
      : platform === 'linux' && arch === 'x64'
        ? 'linux-amd64'
        : platform === 'linux' && arch === 'arm64'
          ? 'linux-arm64'
          : undefined;
  if (!target) throw new Error('error.esp32DebugInstallUnsupported');
  const hosts = {
    win64: [
      'x86_64-w64-mingw32.zip',
      'e970fc3ec8a1d0acee2432e91e0a01b348613a0425aacfa981b2fc505fe920cc',
      32290997,
      '5186ba3f7ee29fb6ab68a4ed7bb417211bad76ecdcdf9280a9187ebfd549a3c1',
      3034680,
    ],
    'linux-amd64': [
      'x86_64-linux-gnu.tar.gz',
      '27b58ab12248e04277c4fdc74038cf0a001d5142df091ab94939ad35053738fd',
      36361058,
      '766293bd7a08900d3536f87a0a7ade960f07266f16e4147f95ca5ce4e15d4c5d',
      2489724,
    ],
    'linux-arm64': [
      'aarch64-linux-gnu.tar.gz',
      '24f85aa778e1605098a13ff7bd29d5760767faf012705c8915cb08b32cad0206',
      35442104,
      '34b6883c372444b49950893b2fc0101aefd10d404a88ef72c97e80199f8544d3',
      2371243,
    ],
  } as const;
  const selected = hosts[target];
  return [
    {
      kind: 'xtensa-esp-elf-gdb',
      version: '16.2_20250324',
      url: `https://github.com/espressif/binutils-gdb/releases/download/esp-gdb-v16.2_20250324/xtensa-esp-elf-gdb-16.2_20250324-${selected[0]}`,
      sha256: selected[1],
      size: selected[2],
    },
    {
      kind: 'openocd-esp32',
      version: 'v0.12.0-esp32-20250707',
      url: `https://github.com/espressif/openocd-esp32/releases/download/v0.12.0-esp32-20250707/openocd-esp32-${target}-0.12.0-esp32-20250707.${target === 'win64' ? 'zip' : 'tar.gz'}`,
      sha256: selected[3],
      size: selected[4],
    },
  ];
}

interface InstallOptions {
  root: string;
  dataRoot: string;
  onProgress?: (progress: InstallationProgress) => void;
  onLine?: (line: string) => void;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  runner?: typeof runCommand;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}
const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    !!relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
  );
};
async function removeOwned(root: string, candidate: string) {
  if (!within(path.resolve(root), path.resolve(candidate))) throw new Error('error.esp32DebugArchive');
  await fs.rm(candidate, { recursive: true, force: true });
}

/** Install a verified publisher archive atomically, retaining the old version on failure. */
export async function installEsp32DebugRelease(
  release: Esp32DebugRelease,
  options: InstallOptions,
): Promise<void> {
  const tool = release.kind === 'openocd-esp32' ? 'Espressif OpenOCD' : 'Xtensa GDB';
  const progress = (phase: InstallationProgress['phase'], extra: Partial<InstallationProgress> = {}) =>
    options.onProgress?.({ tool, phase, ...extra });
  const runner = options.runner ?? runCommand;
  const checkAbort = () => {
    if (options.signal?.aborted) throw new Error('error.operationCancelled');
  };
  let stage: string | undefined, parent: string | undefined;
  progress('starting');
  try {
    checkAbort();
    const url = new URL(release.url);
    if (
      !['xtensa-esp-elf-gdb', 'openocd-esp32'].includes(release.kind) ||
      !/^[\w.-]{1,80}$/.test(release.version) ||
      !/^https:\/\/github\.com\/espressif\/(?:binutils-gdb|openocd-esp32)\/releases\/download\/[\w.-]+\/[\w.-]+$/.test(
        url.href,
      ) ||
      !/^[a-f0-9]{64}$/.test(release.sha256) ||
      !Number.isSafeInteger(release.size) ||
      release.size < 1 ||
      release.size > 100_000_000
    )
      throw new Error('error.esp32DebugArchive');
    for (const base of [
      path.join(path.resolve(options.root), 'esp32-debug'),
      path.join(path.resolve(options.dataRoot), 'esp32-debug'),
    ]) {
      try {
        parent = path.join(base, release.kind);
        await fs.mkdir(parent, { recursive: true });
        stage = await fs.mkdtemp(path.join(parent, '.install-'));
        break;
      } catch (error) {
        if (!['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    if (!stage || !parent) throw new Error('error.esp32DebugInstallPath');
    const timeout = AbortSignal.timeout(600_000);
    const response = await (options.fetcher ?? fetch)(url.href, {
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: { 'User-Agent': 'Blode-Studio' },
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${url.href}`);
    progress('downloading', { receivedBytes: 0, totalBytes: release.size });
    const chunks: Buffer[] = [];
    let size = 0,
      last = 0;
    for await (const chunk of response.body) {
      checkAbort();
      size += chunk.byteLength;
      if (size > release.size) throw new Error('error.esp32DebugChecksum');
      chunks.push(Buffer.from(chunk));
      if (Date.now() - last > 250) {
        progress('downloading', { receivedBytes: size, totalBytes: release.size });
        last = Date.now();
      }
    }
    progress('downloading', { receivedBytes: size, totalBytes: release.size });
    progress('verifying');
    const bytes = Buffer.concat(chunks);
    if (size !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256)
      throw new Error('error.esp32DebugChecksum');
    const archive = path.join(stage, path.basename(url.pathname));
    const extraction = path.join(stage, 'extracted');
    await fs.writeFile(archive, bytes);
    await fs.mkdir(extraction);
    progress('extracting');
    const listing = await runner('tar', ['-tf', archive], { signal: options.signal, timeout: 60_000 });
    if (
      listing.code !== 0 ||
      !listing.output.trim() ||
      listing.output
        .split(/\r?\n/)
        .filter(Boolean)
        .some(
          (entry) =>
            /^(?:[/\\]|[a-z]:)|(?:^|[/\\])\.\.(?:[/\\]|$)|[\0:]/i.test(entry) ||
            !entry.replaceAll('\\', '/').startsWith(release.kind + '/'),
        )
    )
      throw new Error('error.esp32DebugArchive');
    const result = await runner('tar', ['-xf', archive, '-C', extraction], {
      signal: options.signal,
      timeout: 120_000,
    });
    if (result.code !== 0) throw new Error(result.output || 'error.esp32DebugArchive');
    const distribution = path.join(extraction, release.kind);
    const suffix = (options.platform ?? process.platform) === 'win32' ? '.exe' : '';
    const candidates = release.kind === 'openocd-esp32' ? ['openocd'] : [...GDB_NAMES];
    let executable: string | undefined;
    for (const name of candidates) {
      const file = path.join(distribution, 'bin', name + suffix);
      if (await fileExists(file)) {
        executable = file;
        break;
      }
    }
    if (!executable || !within(extraction, await fs.realpath(executable)))
      throw new Error('error.esp32DebugArchive');
    if (
      release.kind === 'openocd-esp32' &&
      !(await hasEsp32Scripts(path.join(distribution, 'share/openocd/scripts')))
    )
      throw new Error('error.esp32DebugArchive');
    const version = await runner(executable, ['--version'], { signal: options.signal, timeout: 15_000 });
    if (
      version.code !== 0 ||
      !(release.kind === 'openocd-esp32' ? /Open On-Chip Debugger.*esp32/is : /GNU gdb/i).test(version.output)
    )
      throw new Error('error.esp32DebugToolInvalid');
    progress('installing');
    checkAbort();
    const destination = path.join(parent, release.version),
      backup = path.join(parent, '.previous-' + randomUUID());
    const existing = await fs.lstat(destination).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error('error.esp32DebugInstallPath');
    if (existing) await fs.rename(destination, backup);
    try {
      await fs.rename(extraction, destination);
    } catch (error) {
      if (existing) await fs.rename(backup, destination);
      throw error;
    }
    if (existing) await removeOwned(parent, backup);
    progress('completed');
    options.onLine?.(`${tool} ${release.version}`);
  } catch (error) {
    progress('failed');
    throw error;
  } finally {
    if (stage && parent) await removeOwned(parent, stage);
  }
}
export async function installEsp32DebugTools(options: InstallOptions): Promise<void> {
  for (const release of esp32DebugReleases(options.platform, options.arch))
    await installEsp32DebugRelease(release, options);
}
