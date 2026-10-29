import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { InstallationProgress } from '../../../src/shared/contracts.js';
import type { RuntimeHost } from '../../runtime.js';

/**
 * GCC is the redistributable STM32 compiler. Arm Compiler 6 stays available
 * when the user already owns Keil MDK, but it cannot be downloaded by us.
 */
export const GNU_WINDOWS_RELEASE = {
  version: 'v15.2.1-1.1',
  asset: 'xpack-arm-none-eabi-gcc-15.2.1-1.1-win32-x64.zip',
  metadataUrl:
    'https://api.github.com/repos/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/tags/v15.2.1-1.1',
  downloadUrl:
    'https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/download/v15.2.1-1.1/xpack-arm-none-eabi-gcc-15.2.1-1.1-win32-x64.zip',
} as const;

const MAX_ARCHIVE_BYTES = 420_000_000;
const REQUIRED_TOOLS = ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'] as const;

interface GnuOptions {
  root: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  onProgress?: (progress: InstallationProgress) => void;
  runner: RuntimeHost['runCommand'];
}

/** Managed GNU Arm Embedded toolchain used when Arm Compiler 6 is unavailable. */
export class GnuArmToolchain {
  private readonly root: string;
  private readonly runner: RuntimeHost['runCommand'];

  constructor(private readonly options: GnuOptions) {
    this.root = path.resolve(options.root);
    this.runner = options.runner;
  }

  private executable(name: string): string {
    return name + (process.platform === 'win32' ? '.exe' : '');
  }

  private async find(directory?: string): Promise<string | null> {
    if (directory && /[\r\n\0]/.test(directory)) throw new Error('errors.stm32CompilerMissing');
    const root = directory ? path.resolve(directory) : this.root;
    const searchPath = directory ? [] : (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter);
    const candidates = new Set([
      path.join(root, 'bin'),
      root,
      ...(directory
        ? []
        : searchPath
            .map((item) => item.trim().replace(/^"(.*)"$/, '$1'))
            .filter((item) => item && path.isAbsolute(item))),
    ]);
    for (const candidate of candidates) {
      const found = await Promise.all(
        REQUIRED_TOOLS.map(async (name) => {
          const info = await fs.lstat(path.join(candidate, this.executable(name))).catch(() => null);
          return !!info?.isFile() && !info.isSymbolicLink();
        }),
      );
      if (found.every(Boolean)) return candidate;
    }
    return null;
  }

  async status(directory?: string): Promise<{ installed: boolean; version: string }> {
    let found: string | null;
    try {
      found = await this.find(directory);
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      return { installed: false, version: '' };
    }
    if (!found) return { installed: false, version: '' };
    try {
      const result = await this.runner(
        path.join(found, this.executable('arm-none-eabi-gcc')),
        ['--version'],
        { timeout: 15_000, signal: this.options.signal },
      );
      return {
        installed: result.code === 0,
        version: /(\d+\.\d+\.\d+)/.exec(result.output)?.[1] ?? '',
      };
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      return { installed: false, version: '' };
    }
  }

  private async fetch(url: string, timeout: number): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const response = await (this.options.fetcher ?? fetch)(url, {
      headers: { 'User-Agent': 'Blode-Studio', Accept: 'application/vnd.github+json' },
      signal: this.options.signal ? AbortSignal.any([this.options.signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response;
  }

  /** Install the pinned Windows x64 archive after verifying its GitHub digest. */
  async install(): Promise<void> {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error('errors.gnuInstallUnsupported');
    this.options.onProgress?.({ tool: 'GNU Arm GCC', phase: 'starting' });
    this.options.onLine?.('status.gnuResolving');
    const release = (await (await this.fetch(GNU_WINDOWS_RELEASE.metadataUrl, 30_000)).json()) as {
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: { name: string; browser_download_url: string; digest?: string; size?: number }[];
    };
    const asset = release.assets?.find((entry) => entry.name === GNU_WINDOWS_RELEASE.asset);
    if (
      release.tag_name !== GNU_WINDOWS_RELEASE.version ||
      release.draft ||
      release.prerelease ||
      !asset ||
      asset.browser_download_url !== GNU_WINDOWS_RELEASE.downloadUrl
    )
      throw new Error('errors.gnuRelease');
    const checksum = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase();
    if (!checksum) throw new Error('errors.gnuChecksum');
    if (
      asset.size !== undefined &&
      (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES)
    )
      throw new Error('errors.gnuArchiveSize');
    this.options.onLine?.('status.gnuDownloading');
    this.options.onProgress?.({
      tool: 'GNU Arm GCC',
      phase: 'downloading',
      receivedBytes: 0,
      totalBytes: asset.size,
    });
    const response = await this.fetch(asset.browser_download_url, 600_000);
    if (!response.body) throw new Error('errors.gnuChecksum');
    const headerSize = Number(response.headers.get('content-length'));
    const totalBytes =
      asset.size ??
      (Number.isSafeInteger(headerSize) && headerSize > 0 && headerSize <= MAX_ARCHIVE_BYTES
        ? headerSize
        : undefined);
    const progress = (receivedBytes: number) =>
      this.options.onProgress?.({
        tool: 'GNU Arm GCC',
        phase: 'downloading',
        receivedBytes,
        totalBytes,
      });
    progress(0);
    const chunks: Buffer[] = [];
    let size = 0;
    let lastProgress = Date.now();
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error('errors.gnuArchiveSize');
      chunks.push(Buffer.from(chunk));
      if (Date.now() - lastProgress >= 500) {
        progress(size);
        lastProgress = Date.now();
      }
    }
    progress(size);
    this.options.onProgress?.({ tool: 'GNU Arm GCC', phase: 'verifying' });
    const bytes = Buffer.concat(chunks);
    if (
      createHash('sha256').update(bytes).digest('hex') !== checksum ||
      (asset.size !== undefined && bytes.length !== asset.size)
    )
      throw new Error('errors.gnuChecksum');
    await fs.mkdir(this.root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(this.root, '.install-'));
    try {
      const archive = path.join(stage, 'gnu-arm.zip');
      const extractionRoot = path.join(stage, 'extracted');
      await fs.writeFile(archive, bytes);
      await fs.mkdir(extractionRoot);
      this.options.onProgress?.({ tool: 'GNU Arm GCC', phase: 'extracting' });
      const listing = await this.runner('tar', ['-tf', archive], {
        timeout: 60_000,
        signal: this.options.signal,
      });
      if (
        listing.code !== 0 ||
        listing.output
          .split(/\r?\n/)
          .some((entry) => /^(?:[\/\\]|[a-z]:)|(?:^|[\/\\])\.\.(?:[\/\\]|$)|\0/i.test(entry))
      )
        throw new Error('errors.gnuExtract');
      const extraction = await this.runner('tar', ['-xf', archive, '-C', extractionRoot], {
        timeout: 300_000,
        signal: this.options.signal,
        onLine: this.options.onLine,
      });
      if (extraction.code !== 0) throw new Error(extraction.output || 'errors.gnuExtract');
      const source = await findToolchainRoot(extractionRoot, this.executable('arm-none-eabi-gcc'));
      if (!source) throw new Error('errors.gnuExtract');
      this.options.onProgress?.({ tool: 'GNU Arm GCC', phase: 'installing' });
      await fs.cp(source, this.root, { recursive: true });
      const installed = await this.status();
      if (!installed.installed) throw new Error('errors.gnuExtract');
      this.options.onLine?.('status.gnuInstalled');
      this.options.onProgress?.({ tool: 'GNU Arm GCC', phase: 'completed' });
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
}

/** Locate the extracted distribution root that contains the verified compiler. */
async function findToolchainRoot(root: string, executable: string): Promise<string | null> {
  const queue: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const { directory, depth } = queue.shift()!;
    const info = await fs.lstat(path.join(directory, 'bin', executable)).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) return directory;
    if (depth >= 3) continue;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink())
        queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  return null;
}
