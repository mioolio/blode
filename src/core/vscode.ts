import { spawn, type SpawnOptions } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectConfig } from '../shared/contracts';
import type { VSCodeOpenRequest, VSCodeOpenResult } from '../shared/vscode';
import { safeWorkspacePath } from './workspace';

const workspaceRelative = '.blode/vscode/project.code-workspace';
type Launcher = (executable: string, args: string[], options: SpawnOptions) => Promise<void>;
interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (file: string) => Promise<boolean>;
}
export interface VSCodeOptions extends DiscoveryOptions {
  projectRoot: () => string;
  config: () => Pick<ProjectConfig, 'toolchain'>;
  findExecutable?: () => Promise<string>;
  launch?: Launcher;
}

/** Resolve Windows launchers to Code.exe; never execute a .cmd/.bat via a shell. */
export async function findVSCodeExecutable(options: DiscoveryOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  const add = (...parts: (string | undefined)[]) => {
    if (parts.every((part) => typeof part === 'string' && part.length))
      candidates.push(path.join(...(parts as string[])));
  };
  if (platform === 'win32') {
    add(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
    add(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe');
    add(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe');
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
    add(env.HOME, 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron');
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const directory of pathValue.split(platform === 'win32' ? ';' : ':')) {
    const clean = directory.replace(/^"|"$/g, '').trim();
    if (!clean || !path.isAbsolute(clean)) continue;
    if (platform === 'win32') {
      add(clean, 'Code.exe');
      // The official code.cmd lives in <installation>/bin.
      add(clean, '..', 'Code.exe');
    } else add(clean, 'code');
  }
  if (platform === 'linux') candidates.push('/usr/share/code/code', '/usr/bin/code', '/snap/bin/code');
  const isExecutable =
    options.isExecutable ??
    (async (file: string) => {
      try {
        if (!(await fs.stat(file)).isFile()) return false;
        await fs.access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  for (const candidate of new Set(candidates)) if (await isExecutable(candidate)) return candidate;
  throw new Error('error.vscodeNotFound');
}

async function launchVSCode(executable: string, args: string[], options: SpawnOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function compilerPath(config: Pick<ProjectConfig, 'toolchain'>, platform: NodeJS.Platform) {
  const directory = config.toolchain.armCompilerDirectory?.trim();
  if (!directory || !path.isAbsolute(directory)) return;
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const name of [`arm-none-eabi-gcc${suffix}`, `armclang${suffix}`])
    for (const file of [path.join(directory, name), path.join(directory, 'bin', name)])
      if ((await fs.stat(file).catch(() => undefined))?.isFile()) return file;
}

/** Generate project-owned configuration and launch the editor on the host machine. */
export async function openVSCode(
  options: VSCodeOptions,
  request: VSCodeOpenRequest,
): Promise<VSCodeOpenResult> {
  if (
    request.confirm !== true ||
    !path.isAbsolute(request.expectedProjectRoot) ||
    /[\0\r\n]/.test(request.expectedProjectRoot) ||
    (request.path !== undefined && /[\0\r\n]/.test(request.path)) ||
    [request.line, request.column].some(
      (value) => value !== undefined && (!Number.isInteger(value) || value < 1 || value > 10_000_000),
    ) ||
    ((request.line !== undefined || request.column !== undefined) && !request.path)
  )
    throw new Error('rpc.invalidParams');
  const selected = options.projectRoot();
  if (!selected) throw new Error('error.noWorkspace');
  const platform = options.platform ?? process.platform;
  const key = (file: string) => {
    const normalized = path.resolve(file);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  if (key(selected) !== key(request.expectedProjectRoot)) throw new Error('error.vscodeProjectChanged');
  const root = await fs.realpath(selected);
  const current = async () => {
    if (
      key(options.projectRoot() || '.') !== key(selected) ||
      (await fs.realpath(selected).catch(() => '')) !== root
    )
      throw new Error('error.vscodeProjectChanged');
  };
  const target = request.path ? await safeWorkspacePath(root, request.path) : undefined;
  if (target && !(await fs.stat(target)).isFile()) throw new Error('error.invalidPath');
  const executable = await (options.findExecutable?.() ?? findVSCodeExecutable(options));
  const compiler = await compilerPath(options.config(), platform);
  const document = {
    folders: [{ name: path.basename(root), path: '../..' }],
    settings: {
      'files.autoSave': 'afterDelay',
      'files.autoSaveDelay': 750,
      'files.encoding': 'utf8',
      'files.associations': { '*.ino': 'cpp' },
      'C_Cpp.default.includePath': ['${workspaceFolder}/**'],
      ...(compiler ? { 'C_Cpp.default.compilerPath': compiler } : {}),
    },
    extensions: { recommendations: ['ms-vscode.cpptools'] },
  };
  await current();
  const directory = await safeWorkspacePath(root, '.blode/vscode', { internal: true });
  await fs.mkdir(directory, { recursive: true });
  await safeWorkspacePath(root, '.blode/vscode', { internal: true });
  const temporaryRelative = `.blode/vscode/${randomUUID()}.tmp`;
  const temporary = await safeWorkspacePath(root, temporaryRelative, { internal: true });
  let workspaceFile = '';
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await current();
    await safeWorkspacePath(root, temporaryRelative, { internal: true });
    workspaceFile = await safeWorkspacePath(root, workspaceRelative, { internal: true });
    await fs.rename(temporary, workspaceFile);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  await current();
  await safeWorkspacePath(root, workspaceRelative, { internal: true });
  if (request.path) await safeWorkspacePath(root, request.path);
  const args = ['--reuse-window', workspaceFile];
  if (target) args.push('--goto', `${target}:${request.line ?? 1}:${request.column ?? 1}`);
  const env = { ...process.env, ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await (options.launch ?? launchVSCode)(executable, args, {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
  } catch {
    throw new Error('error.vscodeLaunch');
  }
  return { workspaceFile, executable };
}
