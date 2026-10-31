import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readZip } from '../zip-reader';
import { clangdRelease, clangdExecutable } from './manifest';

const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_EXTRACTED = 512 * 1024 * 1024;

export interface ClangdInstallProgress {
  phase: 'starting' | 'downloading' | 'verifying' | 'extracting' | 'installing';
  receivedBytes?: number;
  totalBytes?: number;
}

export interface ClangdInstallOptions {
  directory: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: ClangdInstallProgress) => void;
  onLine?: (line: string) => void;
}

function archivePrefix(names: string[]): string {
  const first = names[0]?.split('/')[0];
  if (!first || !/^clangd_[0-9A-Za-z._-]+$/.test(first)) return '';
  return names.every((name) => name === first || name.startsWith(first + '/')) ? first + '/' : '';
}

async function extract(files: Map<string, Buffer>, directory: string, platform: NodeJS.Platform) {
  const prefix = archivePrefix([...files.keys()]);
  if (!prefix) throw new Error('error.toolVersionExtract');
  for (const [name, data] of files) {
    if (!name.startsWith(prefix)) throw new Error('error.toolVersionExtract');
    const relative = name.slice(prefix.length);
    const target = path.resolve(directory, relative);
    const boundary = path.resolve(directory) + path.sep;
    if (!target.startsWith(boundary)) throw new Error('error.toolVersionExtract');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: 'wx', mode: platform === 'win32' ? 0o644 : 0o644 });
    if (platform !== 'win32' && relative.startsWith('bin/')) await fs.chmod(target, 0o755);
  }
}

/** Exposed for tests: strip the release folder and write a safe archive tree. */
export async function extractClangdArchive(
  files: Map<string, Buffer>,
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await extract(files, directory, platform);
}

/**
 * Download, verify and unpack one pinned clangd release. The caller owns the
 * final version directory and progress reporting to Preferences.
 */
export async function installClangd(options: ClangdInstallOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const release = clangdRelease(platform, options.arch ?? process.arch);
  if (!release) throw new Error('error.toolVersionUnsupported');
  const progress = (value: ClangdInstallProgress) => options.onProgress?.(value);
  progress({ phase: 'starting', totalBytes: release.size });
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(900_000)])
    : AbortSignal.timeout(900_000);
  const response = await (options.fetcher ?? fetch)(release.downloadUrl, {
    signal,
    headers: { 'User-Agent': 'Blode-Studio' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${release.downloadUrl}`);
  if (!response.body) throw new Error('error.toolVersionChecksum');
  const chunks: Buffer[] = [];
  let size = 0;
  let last = 0;
  const report = () => progress({ phase: 'downloading', receivedBytes: size, totalBytes: release.size });
  report();
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_ARCHIVE) throw new Error('error.toolVersionExtract');
    chunks.push(Buffer.from(chunk));
    if (Date.now() - last > 400) {
      report();
      last = Date.now();
    }
  }
  report();
  progress({ phase: 'verifying', receivedBytes: size, totalBytes: release.size });
  const bytes = Buffer.concat(chunks);
  if (size !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256)
    throw new Error('error.toolVersionChecksum');

  const files = readZip(bytes, {
    maxArchive: MAX_ARCHIVE,
    maxFile: MAX_EXTRACTED / 2,
    maxTotal: MAX_EXTRACTED,
    maxEntries: 4096,
    invalidError: 'error.toolVersionExtract',
    tooLargeError: 'error.toolVersionExtract',
  });
  progress({ phase: 'extracting' });
  await fs.mkdir(path.dirname(options.directory), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(options.directory), '.clangd-install-'));
  try {
    await extract(files, staging, platform);
    const executable = path.join(staging, 'bin', clangdExecutable(platform));
    const stat = await fs.stat(executable).catch(() => null);
    if (!stat?.isFile()) throw new Error('error.toolVersionExtract');
    if (platform !== 'win32') await fs.chmod(executable, 0o755);
    progress({ phase: 'installing' });
    await fs.rm(options.directory, { recursive: true, force: true });
    await fs.rename(staging, options.directory);
    options.onLine?.(`clangd ${release.version} installed at ${options.directory}`);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
