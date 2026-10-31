import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClangdSource } from '../../shared/clangd';
import { CLANGD_VERSION, clangdExecutable } from './manifest';

const execFileAsync = promisify(execFile);

export interface ClangdInstallation {
  path: string;
  source: ClangdSource;
  version?: string;
}

const executableFile = async (file: string, platform: NodeJS.Platform) => {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  if (platform === 'win32') return true;
  return fs
    .access(file, fsConstants.X_OK)
    .then(() => true)
    .catch(() => false);
};

const compareVersions = (a: string, b: string) => {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] || 0) - (left[index] || 0);
    if (difference) return difference;
  }
  return a.localeCompare(b);
};

async function managedVersions(root: string, platform: NodeJS.Platform): Promise<string[]> {
  const directory = path.join(root, 'versions', 'clangd');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(compareVersions);
}

async function pathCandidates(env: NodeJS.ProcessEnv | undefined, executable: string) {
  const value = env ? (env.PATH ?? env.Path) : process.env.PATH;
  if (!value) return [];
  return value
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => path.join(directory, executable));
}

/**
 * Resolve the clangd executable without starting it. Order: explicit project
 * setting, tools bundled beside the app, managed versions, then the host PATH.
 */
export async function findClangd(
  options: {
    toolchainRoot?: string;
    configuredPath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    arch?: string;
    probe?: (file: string) => Promise<string | undefined>;
  } = {},
): Promise<ClangdInstallation | undefined> {
  const platform = options.platform ?? process.platform;
  const executable = clangdExecutable(platform);
  const candidates: { path: string; source: ClangdSource }[] = [];
  if (options.configuredPath) candidates.push({ path: options.configuredPath, source: 'custom' });
  if (options.toolchainRoot) {
    candidates.push({
      path: path.join(options.toolchainRoot, 'clangd', 'bin', executable),
      source: 'bundled',
    });
    candidates.push({
      path: path.join(options.toolchainRoot, 'versions', 'clangd', CLANGD_VERSION, 'bin', executable),
      source: 'managed',
    });
    for (const version of await managedVersions(options.toolchainRoot, platform))
      candidates.push({
        path: path.join(options.toolchainRoot, 'versions', 'clangd', version, 'bin', executable),
        source: 'managed',
      });
  }
  for (const candidate of await pathCandidates(options.env, executable))
    candidates.push({ path: candidate, source: 'path' });

  const probe =
    options.probe ??
    (async (file: string) => {
      try {
        const { stdout } = await execFileAsync(file, ['--version'], {
          timeout: 5_000,
          windowsHide: true,
          maxBuffer: 256 * 1024,
        });
        return /clangd version\s+(\S+)/.exec(stdout)?.[1];
      } catch {
        return undefined;
      }
    });
  for (const candidate of candidates) {
    if (!(await executableFile(candidate.path, platform))) continue;
    const version = await probe(candidate.path).catch(() => undefined);
    return { path: candidate.path, source: candidate.source, version };
  }
  return undefined;
}
