import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DebugProbeInfo, InstallationProgress } from '../../../../src/shared/contracts.js';
import type { RuntimeHost, RuntimeCommandResult } from '../../../runtime.js';
import { stlinkBinaryDirectories, stlinkPackageDirectory } from '../tools/stlink-discovery.js';
import {
  buildStlinkFlashArgs,
  buildStlinkProbeArgs,
  parseStlinkProbes,
  validateStlinkSerial,
} from './protocol.js';

export const STLINK_WINDOWS_RELEASE = {
  version: 'v1.9.0',
  asset: 'stlink-1.9.0-x86_64-w64-mingw32.zip',
  metadataUrl: 'https://api.github.com/repos/stlink-org/stlink/releases/tags/v1.9.0',
  downloadUrl:
    'https://github.com/stlink-org/stlink/releases/download/v1.9.0/stlink-1.9.0-x86_64-w64-mingw32.zip',
} as const;

interface StlinkOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  onProgress?: (progress: InstallationProgress) => void;
  runner: RuntimeHost['runCommand'];
}

const MAX_ARCHIVE_BYTES = 50_000_000;

/** ST-Link USB/SWD programming is independent of a board's UART/COM port. */
export class StlinkProgrammer {
  private readonly root: string;
  private readonly runner: RuntimeHost['runCommand'];
  private resolved = new Map<string, string>();

  constructor(private readonly options: StlinkOptions) {
    this.root = path.resolve(options.root);
    this.runner = options.runner;
  }

  private async executable(name: 'st-info' | 'st-flash', directory?: string): Promise<string> {
    if (directory && /[\r\n\0]/.test(directory)) throw new Error('errors.stlinkMissing');
    const filename = `${name}${(this.options.platform ?? process.platform) === 'win32' ? '.exe' : ''}`;
    const root = directory ? path.resolve(directory) : this.root;
    const bins = await stlinkBinaryDirectories({ ...this.options, directory });
    const selected = this.resolved.get(directory || '');
    if (selected && bins.includes(selected)) return path.join(selected, filename);
    for (const candidate of bins.map((bin) => path.join(bin, filename))) {
      const info = await fs.lstat(candidate).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) return candidate;
    }
    // Explicit directories never silently fall back to a different installation.
    return directory ? path.join(root, filename) : filename;
  }

  private async run(
    command: string,
    args: string[],
    timeout = 30_000,
    quiet = false,
  ): Promise<RuntimeCommandResult> {
    return this.runner(command, args, {
      timeout,
      signal: this.options.signal,
      env: this.options.env,
      onLine: quiet ? undefined : this.options.onLine,
    });
  }

  async status(directory?: string): Promise<{
    installed: boolean;
    version: string;
    directory?: string;
    binaryDirectory?: string;
  }> {
    try {
      const bins = await stlinkBinaryDirectories({ ...this.options, directory });
      const suffix = (this.options.platform ?? process.platform) === 'win32' ? '.exe' : '';
      for (const bin of bins.length ? bins : [undefined]) {
        const results = await Promise.all(
          ['st-info', 'st-flash'].map((name) =>
            this.run(
              bin
                ? path.join(bin, name + suffix)
                : directory
                  ? path.join(directory, name + suffix)
                  : name + suffix,
              ['--version'],
              4000,
              true,
            ).catch((error) => {
              if (this.options.signal?.aborted) throw error;
              return { code: -1, output: '' };
            }),
          ),
        );
        const versions = results.map((result) => /\bv?(\d+\.\d+\.\d+)\b/.exec(result.output)?.[1] ?? '');
        if (results.every((result) => result.code === 0) && versions[0] && versions[0] === versions[1]) {
          if (bin) this.resolved.set(directory || '', bin);
          return {
            installed: true,
            version: versions[0],
            ...(bin ? { binaryDirectory: bin, directory: stlinkPackageDirectory(bin) } : {}),
          };
        }
      }
      this.resolved.delete(directory || '');
      return { installed: false, version: '' };
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      return { installed: false, version: '' };
    }
  }

  private async enumerate(directory?: string, frequencyKhz = 1800) {
    const args = buildStlinkProbeArgs(frequencyKhz);
    let result: RuntimeCommandResult;
    try {
      result = await this.run(await this.executable('st-info', directory), args);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('errors.stlinkMissing');
      throw error;
    }
    if (result.code !== 0) throw new Error(result.output || 'errors.stlinkTargetUnknown');
    return { output: result.output, devices: parseStlinkProbes(result.stdout ?? result.output) };
  }

  async listProbes(directory?: string, frequencyKhz = 1800): Promise<DebugProbeInfo[]> {
    return (await this.enumerate(directory, frequencyKhz)).devices;
  }

  async probe(
    serialNumber: string,
    frequencyKhz: number,
    directory?: string,
  ): Promise<{ output: string; device: DebugProbeInfo }> {
    validateStlinkSerial(serialNumber);
    const result = await this.enumerate(directory, frequencyKhz);
    const device = result.devices.find(
      (entry) => entry.serialNumber.toLowerCase() === serialNumber.toLowerCase(),
    );
    if (!device) throw new Error('errors.stlinkProbeNotFound');
    // st-info emits dev-type only when its chip database recognizes the target.
    if (
      !device.chipId ||
      !device.flashSize ||
      !device.description ||
      /unknown|unrecognized/i.test(device.description)
    )
      throw new Error('errors.stlinkTargetUnknown');
    return { output: result.output, device };
  }

  async flash(options: {
    serialNumber: string;
    frequencyKhz: number;
    file: string;
    address: number;
    flashSize: number;
    directory?: string;
  }): Promise<string> {
    const info = await fs.lstat(options.file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('errors.invalidFirmwarePath');
    // Validate before making even a read-only hardware connection.
    const args = buildStlinkFlashArgs({ ...options, size: info.size });
    const { device } = await this.probe(options.serialNumber, options.frequencyKhz, options.directory);
    if (device.flashSize !== options.flashSize) throw new Error('errors.stlinkCapacityMismatch');
    // USB serial matching in stlink is case-sensitive; use the exact enumerated
    // spelling after accepting an equivalent hex selection from configuration.
    args[args.indexOf('--serial') + 1] = device.serialNumber;
    const result = await this.run(await this.executable('st-flash', options.directory), args, 180_000);
    // stlink_fwrite_flash -> stlink_write_flash -> stlink_verify_write_flash
    // performs readback verification; any mismatch gives a nonzero exit status.
    if (result.code !== 0) throw new Error(result.output || 'errors.stlinkVerifyFailed');
    return result.output;
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

  /** Install only the official stable Windows x64 archive, verified against its GitHub digest. */
  async install(): Promise<void> {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error('errors.stlinkInstallUnsupported');
    this.options.onProgress?.({ tool: 'stlink-tools', phase: 'starting' });
    this.options.onLine?.('status.stlinkResolving');
    const release = (await (await this.fetch(STLINK_WINDOWS_RELEASE.metadataUrl, 30_000)).json()) as {
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: { name: string; browser_download_url: string; digest?: string; size?: number }[];
    };
    const asset = release.assets?.find((entry) => entry.name === STLINK_WINDOWS_RELEASE.asset);
    if (
      release.tag_name !== STLINK_WINDOWS_RELEASE.version ||
      release.draft ||
      release.prerelease ||
      !asset ||
      asset.browser_download_url !== STLINK_WINDOWS_RELEASE.downloadUrl
    )
      throw new Error('errors.stlinkRelease');
    const checksum = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase();
    if (!checksum) throw new Error('errors.stlinkChecksum');
    if (
      asset.size !== undefined &&
      (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES)
    )
      throw new Error('errors.stlinkArchiveSize');
    this.options.onLine?.('status.stlinkDownloading');
    this.options.onProgress?.({
      tool: 'stlink-tools',
      phase: 'downloading',
      receivedBytes: 0,
      totalBytes: asset.size,
    });
    const response = await this.fetch(asset.browser_download_url, 180_000);
    if (!response.body) throw new Error('errors.stlinkChecksum');
    const headerSize = Number(response.headers.get('content-length'));
    const totalBytes =
      asset.size ??
      (Number.isSafeInteger(headerSize) && headerSize > 0 && headerSize <= MAX_ARCHIVE_BYTES
        ? headerSize
        : undefined);
    const progress = (receivedBytes: number) =>
      this.options.onProgress?.({
        tool: 'stlink-tools',
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
      if (size > MAX_ARCHIVE_BYTES) throw new Error('errors.stlinkArchiveSize');
      chunks.push(Buffer.from(chunk));
      if (Date.now() - lastProgress >= 500) {
        progress(size);
        lastProgress = Date.now();
      }
    }
    progress(size);
    this.options.onProgress?.({ tool: 'stlink-tools', phase: 'verifying' });
    const bytes = Buffer.concat(chunks);
    if (
      createHash('sha256').update(bytes).digest('hex') !== checksum ||
      (asset.size !== undefined && bytes.length !== asset.size)
    )
      throw new Error('errors.stlinkChecksum');
    await fs.mkdir(this.root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(this.root, '.install-'));
    try {
      const archive = path.join(stage, 'stlink.zip');
      const extractionRoot = path.join(stage, 'extracted');
      await fs.writeFile(archive, bytes);
      await fs.mkdir(extractionRoot);
      this.options.onProgress?.({ tool: 'stlink-tools', phase: 'extracting' });
      const tar = path.join(
        this.options.env?.SystemRoot || process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'tar.exe',
      );
      const listing = await this.run(tar, ['-tf', archive], 30_000, true);
      if (
        listing.code !== 0 ||
        listing.output
          .split(/\r?\n/)
          .some((entry) => /^(?:[\/\\]|[a-z]:)|(?:^|[\/\\])\.\.(?:[\/\\]|$)|\0/i.test(entry))
      )
        throw new Error('errors.stlinkExtract');
      const extraction = await this.run(tar, ['-xf', archive, '-C', extractionRoot], 60_000);
      if (extraction.code !== 0) throw new Error(extraction.output || 'errors.stlinkExtract');
      const binaryDirectory = await findBinaryDirectory(extractionRoot);
      if (!binaryDirectory) throw new Error('errors.stlinkExtract');
      const source =
        path.basename(binaryDirectory).toLowerCase() === 'bin'
          ? path.dirname(binaryDirectory)
          : binaryDirectory;
      // Preserve share/stlink/chips and dependent DLLs, not just the two executables.
      this.options.onProgress?.({ tool: 'stlink-tools', phase: 'installing' });
      await fs.cp(source, this.root, { recursive: true });
      const installedDirectory =
        path.basename(binaryDirectory).toLowerCase() === 'bin' ? path.join(this.root, 'bin') : this.root;
      // Files extracted below a Low-labelled development folder inherit Low too.
      // Only restore executable files from the newly verified distribution; leave DACLs intact.
      const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
      const executables = (await fs.readdir(binaryDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
        .map((entry) => entry.name);
      for (const tool of executables) {
        const repaired = await this.run(
          icacls,
          [path.join(installedDirectory, tool), '/setintegritylevel', 'Medium'],
          30_000,
          true,
        );
        if (repaired.code !== 0) throw new Error(repaired.output || 'errors.stlinkExtract');
      }
      if (!(await this.status(installedDirectory)).installed) throw new Error('errors.stlinkMissing');
      await fs.writeFile(
        path.join(this.root, 'stlink.lock.json'),
        JSON.stringify(
          {
            version: release.tag_name,
            asset: asset.name,
            sha256: checksum,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n',
      );
      this.options.onLine?.('status.stlinkInstalled');
      this.options.onProgress?.({ tool: 'stlink-tools', phase: 'completed' });
    } finally {
      // stage is created directly under this.root by mkdtemp, never supplied by a project.
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
}

async function findBinaryDirectory(root: string, depth = 0): Promise<string | undefined> {
  if (depth > 4) return undefined;
  const entries = await fs.readdir(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) throw new Error('errors.stlinkExtract');
  if (
    ['st-info.exe', 'st-flash.exe'].every((name) =>
      entries.some((entry) => entry.name === name && entry.isFile()),
    )
  )
    return root;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findBinaryDirectory(path.join(root, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
