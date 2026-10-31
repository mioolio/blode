import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPackageApproval, verifyPackageDirectory } from './package-signing';
import type { PackageApproval, PackageVerification } from '../shared/package-signing';
import { Readable } from 'node:stream';
import * as z from 'zod';
import { ToolVersions, arduinoCliAsset } from './tool-versions';
import { gnuRelease } from '../../extensions/boards/STM32F103C8T6/tools/gnu';
import { writeZip, type ZipEntry, type FileZipEntry } from './zip';
import { repairInstalledToolIntegrity } from './tool-integrity';
import {
  type ToolPackageResult,
  type ToolVersionEntry,
  type ToolVersionKind,
  type ToolVersionsState,
} from '../shared/tool-versions';
import type { ProjectConfig, InstallationProgress } from '../shared/contracts';
import type { RuntimeHost } from '../../extensions/runtime';
import type { ArchiveWriter } from './archive-writer';

const MANIFEST = 'blode-tool-package.json',
  SNAPSHOT = 'blode-tool-snapshot.json',
  MAX_TOTAL = 1_500_000_000,
  MAX_FILE = 500_000_000,
  SNAPSHOT_TOTAL = 3_500_000_000,
  SNAPSHOT_ENTRIES = 60_000,
  MAX_PACKAGE = SNAPSHOT_TOTAL + 400_000_000;
const TOOL_KINDS = [
  'gnu-arm',
  'arduino-cli',
  'arduino-esp32',
  'stlink',
  'clangd',
  'armclang',
  'armcc',
] as const;
type SnapshotTool = Omit<ToolVersionEntry, 'kind'> & {
  kind: (typeof TOOL_KINDS)[number];
  binaryDirectory?: string;
};
const safe = (value: string) =>
  !!value &&
  !/[\\<>:"|?*\0-\x1f]/.test(value) &&
  !value
    .split('/')
    .some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );
const recordSchema = z
  .object({
    path: z.string().max(512).refine(safe),
    url: z.string().url().max(2048),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(0).max(MAX_FILE),
    role: z.enum(['metadata', 'index', 'archive']),
    destination: z.string().max(512).refine(safe).optional(),
  })
  .strict();
const schema = z
  .object({
    format: z.literal('blode-tool-package'),
    version: z.literal(1),
    toolId: z.string().max(128),
    platform: z.string().max(32),
    arch: z.string().max(32),
    files: z.array(recordSchema).min(1).max(128),
  })
  .strict();
type Manifest = z.infer<typeof schema>;
type Record = z.infer<typeof recordSchema>;
const snapshotRecordSchema = z
  .object({
    path: z.string().max(512).refine(safe),
    size: z.number().int().min(0).max(SNAPSHOT_TOTAL),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().min(0).max(0o777).optional(),
  })
  .strict();
const snapshotSchema = z
  .object({
    format: z.literal('blode-tool-snapshot'),
    version: z.literal(1),
    toolId: z.string().max(128),
    kind: z.enum(TOOL_KINDS),
    toolVersion: z.string().max(64),
    platform: z.string().max(32),
    arch: z.string().max(32),
    files: z.array(snapshotRecordSchema).min(1).max(SNAPSHOT_ENTRIES),
  })
  .strict();
type SnapshotManifest = z.infer<typeof snapshotSchema>;
export interface OfflineToolOptions {
  enforceSignatures?: boolean;
  archiver?: ArchiveWriter;
  root: string;
  dataRoot: string;
  config: () => ProjectConfig | Promise<ProjectConfig>;
  runner: RuntimeHost['runCommand'];
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  onProgress?: (progress: InstallationProgress) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}
const bytesLabel = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MiB`;
const digest = async (file: string, signal?: AbortSignal, onBytes?: (bytes: number) => void) => {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    hash.update(chunk);
    bytes += chunk.length;
    onBytes?.(bytes);
  }
  return hash.digest('hex');
};
const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
export class OfflineTools {
  private extractedBytes = 0;
  private extractedCount = 0;
  private operation: 'download' | 'install' | 'export' = 'download';
  private artifacts = new Map<string, { path: string; name: string }>();
  constructor(private readonly options: OfflineToolOptions) {}
  private get platform() {
    return this.options.platform ?? process.platform;
  }
  private get arch() {
    return this.options.arch ?? process.arch;
  }
  private get tarCommand() {
    if (this.platform !== 'win32') return 'tar';
    const systemRoot = this.options.env?.SystemRoot ?? process.env.SystemRoot;
    return systemRoot ? path.join(systemRoot, 'System32', 'tar.exe') : 'tar';
  }
  private progress(
    tool: string,
    phase: InstallationProgress['phase'],
    receivedBytes?: number,
    totalBytes?: number,
    percent?: number,
  ) {
    this.options.onProgress?.({ tool, phase, receivedBytes, totalBytes, percent, operation: this.operation });
  }
  private log(key: string, detail: string | number) {
    this.options.onLine?.(`${key}: ${detail}`);
  }
  private async response(url: string) {
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, AbortSignal.timeout(600000)])
      : AbortSignal.timeout(600000);
    const response = await (this.options.fetcher ?? fetch)(url, {
      signal,
      headers: { 'User-Agent': 'Blode-Studio' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }
  private async writeResponse(response: Response, file: string, tool: string, total?: number) {
    if (!response.body) throw new Error('error.toolPackageChecksum');
    let received = 0,
      last = 0;
    const hash = createHash('sha256'),
      handle = await fs.open(file, 'wx');
    try {
      for await (const chunk of response.body) {
        this.options.signal?.throwIfAborted();
        received += chunk.byteLength;
        if (received > MAX_FILE) throw new Error('error.toolPackageInvalid');
        hash.update(chunk);
        await handle.writeFile(chunk);
        if (Date.now() - last > 250) {
          this.progress(tool, 'downloading', received, total);
          last = Date.now();
        }
      }
    } finally {
      await handle.close();
    }
    this.progress(tool, 'downloading', received, total);
    return { size: received, sha256: hash.digest('hex') };
  }
  private async exists(file: string) {
    const info = await fs.lstat(file).catch(() => null);
    return !!info?.isFile() && !info.isSymbolicLink();
  }
  private async snapshotFiles(
    directory: string,
    include: (relative: string, isDirectory: boolean) => boolean = () => true,
    onFile?: (file: SnapshotManifest['files'][number]) => void,
  ) {
    const files: SnapshotManifest['files'] = [];
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error('error.toolPackageExtract');
    const actualDirectory = await fs.realpath(directory);
    this.log('status.exportScanDirectory', directory);
    let total = 0;
    const visit = async (current: string, prefix: string) => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        this.options.signal?.throwIfAborted();
        if (
          entry.name.startsWith('.') ||
          /^(?:cache|tmp|temp|downloads|logs|__pycache__)$/i.test(entry.name) ||
          /\.(?:key|pem|pfx|p12|lic|licx|log|pyc)$/i.test(entry.name) ||
          /^(?:tools\.ini|license\.dat)$/i.test(entry.name)
        )
          continue;
        const file = path.join(current, entry.name),
          relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!include(relative, entry.isDirectory())) continue;
        if (!safe(relative) || entry.isSymbolicLink()) throw new Error('error.toolPackageExtract');
        if (entry.isDirectory()) {
          await visit(file, relative);
          continue;
        }
        if (!entry.isFile()) throw new Error('error.toolPackageExtract');
        if (files.length >= SNAPSHOT_ENTRIES) throw new Error('error.toolPackageTooLarge');
        const info = await fs.lstat(file);
        if (info.isSymbolicLink() || !inside(actualDirectory, await fs.realpath(file)))
          throw new Error('error.toolPackageExtract');
        total += info.size;
        if (total > SNAPSHOT_TOTAL) throw new Error('error.toolPackageTooLarge');
        const record = {
          path: relative,
          size: info.size,
          sha256: '',
          mode: info.mode & 0o777,
        };
        onFile?.(record);
        record.sha256 = await digest(file, this.options.signal);
        files.push(record);
      }
    };
    await visit(directory, '');
    return files;
  }
  private async writeSnapshot(entry: SnapshotTool, destination: string) {
    this.progress(entry.name, 'collecting');
    const source = entry.directory;
    if (!source) throw new Error('error.toolVersionNotInstalled');
    const rootStat = await fs.lstat(source);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('error.toolPackageExtract');
    const extra = new Map<string, Buffer>();
    const sources = new Map<string, string>();
    let collected = 0,
      lastCollected = 0;
    const onFile = (file: SnapshotManifest['files'][number]) => {
      collected++;
      if (collected === 1 || Date.now() - lastCollected > 500) {
        this.log('status.exportCurrentFile', `${file.path} (${bytesLabel(file.size)})`);
        this.options.onProgress?.({
          tool: entry.name,
          operation: 'export',
          phase: 'collecting',
          processedFiles: collected,
        });
        lastCollected = Date.now();
      }
    };
    let files: SnapshotManifest['files'];
    if (await this.exists(path.join(source, 'obe'))) {
      files = await this.snapshotFiles(source, undefined, onFile);
      for (const file of files) sources.set(file.path, path.join(source, file.path));
    } else if (entry.kind === 'arduino-esp32') {
      files = (
        await this.snapshotFiles(path.join(source, 'arduino-data', 'packages'), undefined, onFile)
      ).map((file) => ({
        ...file,
        path: `arduino-data/packages/${file.path}`,
      }));
      extra.set('installed.json', Buffer.from(JSON.stringify({ version: entry.version, offline: true })));
      extra.set(
        'arduino-cli.yaml',
        Buffer.from(
          JSON.stringify({
            directories: { data: './arduino-data', downloads: './downloads', user: './libraries' },
          }),
        ),
      );
      for (const [relative, bytes] of extra)
        files.push({
          path: relative,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
    } else {
      const main: { [kind: string]: string } = {
        'gnu-arm': 'arm-none-eabi-gcc',
        armclang: 'armclang',
        armcc: 'armcc',
        stlink: 'st-info',
        clangd: 'clangd',
        'arduino-cli': 'arduino-cli',
      };
      const suffix = this.platform === 'win32' ? '.exe' : '';
      const binaryDirectory =
        entry.binaryDirectory ??
        ((await this.exists(path.join(source, 'bin', main[entry.kind] + suffix)))
          ? path.join(source, 'bin')
          : source);
      if (!inside(await fs.realpath(source), await fs.realpath(binaryDirectory)))
        throw new Error('error.toolPackageExtract');
      const native = (name: string) =>
        /\.dll$/i.test(name) ||
        (entry.kind === 'gnu-arm'
          ? /^arm-none-eabi-/i.test(name)
          : entry.kind === 'armclang' || entry.kind === 'armcc'
            ? /^(?:armcc|armclang|armlink|fromelf|armar|armasm|llvm-[\w-]+)(?:\.exe)?$/i.test(name)
            : entry.kind === 'stlink'
              ? /^(?:st-[\w-]+|stlink[\w.-]*)(?:\.exe)?$/i.test(name)
              : name === main[entry.kind] + suffix);
      files = [];
      for (const file of await this.snapshotFiles(
        binaryDirectory,
        (relative, directory) => !directory && native(relative),
        onFile,
      )) {
        sources.set('bin/' + file.path, path.join(binaryDirectory, file.path));
        files.push({ ...file, path: 'bin/' + file.path });
      }
      const roots =
        entry.kind === 'gnu-arm'
          ? ['arm-none-eabi', 'lib/gcc/arm-none-eabi', 'libexec/gcc/arm-none-eabi', 'lib64/gcc/arm-none-eabi']
          : entry.kind === 'armclang' || entry.kind === 'armcc'
            ? ['lib', 'include', 'sw']
            : entry.kind === 'clangd'
              ? ['lib/clang']
              : entry.kind === 'stlink'
                ? ['share/stlink']
                : [];
      for (const file of await this.snapshotFiles(
        source,
        (relative, directory) =>
          roots.some(
            (root) =>
              relative === root ||
              relative.startsWith(root + '/') ||
              (directory && root.startsWith(relative + '/')),
          ) ||
          (entry.kind === 'stlink' &&
            ((directory && relative === 'lib') || /^lib\/(?:libstlink|libusb)[^/]*$/i.test(relative))),
        onFile,
      )) {
        if (sources.has(file.path)) continue;
        sources.set(file.path, path.join(source, file.path));
        files.push(file);
      }
    }
    if (!files.length) throw new Error('error.toolVersionNotInstalled');
    const manifest: SnapshotManifest = {
      format: 'blode-tool-snapshot',
      version: 1,
      toolId: entry.id,
      kind: entry.kind,
      toolVersion: entry.version,
      platform: this.platform,
      arch: this.arch,
      files,
    };
    snapshotSchema.parse(manifest);
    const sourceBytes = files.reduce((total, file) => total + file.size, 0);
    this.log('status.exportManifestFiles', files.length);
    this.log('status.exportManifestSize', bytesLabel(sourceBytes));
    this.log('status.exportManifestWritten', SNAPSHOT);
    this.options.onLine?.('status.exportStaging');
    let lastPackingPercent = -10,
      lastPackingUpdate = 0,
      reportedPercent = -1;
    const onPacking = (percent: number) => {
      if (
        percent !== reportedPercent &&
        (Date.now() - lastPackingUpdate > 100 || percent === 0 || percent === 100)
      ) {
        this.progress(entry.name, 'packing', undefined, undefined, percent);
        lastPackingUpdate = Date.now();
        reportedPercent = percent;
      }
      if (percent < lastPackingPercent) lastPackingPercent = -10;
      if (percent >= lastPackingPercent + 10 || (percent === 100 && lastPackingPercent !== 100)) {
        this.log('status.exportCompressionProgress', `${percent.toFixed(0)}%`);
        lastPackingPercent = percent;
      }
    };
    if (!this.options.archiver) this.progress(entry.name, 'packing', undefined, undefined, 0);
    await (this.options.archiver ? this.options.archiver.write.bind(this.options.archiver) : writeZip)(
      destination,
      (async function* () {
        yield { path: SNAPSHOT, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') };
        for (const item of files) {
          const data = extra.get(item.path);
          if (data) yield { path: `files/${item.path}`, data, mode: item.mode };
          else
            yield {
              path: `files/${item.path}`,
              data: { file: sources.get(item.path) ?? path.join(source, ...item.path.split('/')) },
              mode: item.mode,
            };
        }
      })(),
      {
        signal: this.options.signal,
        maxEntries: SNAPSHOT_ENTRIES + 1,
        maxBytes: SNAPSHOT_TOTAL + 50_000_000,
        entryCount: files.length + 1,
        onStage: (processedFiles: number, totalFiles: number) =>
          this.options.onProgress?.({
            tool: entry.name,
            operation: 'export',
            phase: 'collecting',
            processedFiles,
            totalFiles,
          }),
        onProgress: onPacking,
        onLine: this.options.onLine,
      },
    );
    onPacking(100);
    const size = (await fs.stat(destination)).size;
    this.log('status.exportArchiveSize', bytesLabel(size));
    this.progress(entry.name, 'verifying');
    let lastVerified = 0;
    const sha256 = await digest(destination, this.options.signal, (bytes) => {
      if (Date.now() - lastVerified > 250 || bytes === size) {
        this.progress(entry.name, 'verifying', undefined, undefined, (bytes / size) * 100);
        lastVerified = Date.now();
      }
    });
    this.log('status.exportChecksum', sha256);
    return {
      size,
      sha256,
    };
  }
  /** Package an already installed managed toolchain so another client can install it offline. */
  async exportInstalled(request: { id: string; confirm: true }): Promise<ToolPackageResult> {
    this.operation = 'export';
    if (request.confirm !== true) throw new Error('error.invalidArguments');
    const started = performance.now();
    this.options.signal?.throwIfAborted();
    this.options.onLine?.('status.exportRefreshInventory');
    const state = await new ToolVersions(this.options).toolVersionsState();
    this.options.signal?.throwIfAborted();
    const local = state.localTools?.find((item) => item.id === request.id);
    const entry: SnapshotTool | undefined =
      state.entries.find((item) => item.id === request.id) ??
      (local && local.exportable && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(local.version || 'unknown')
        ? {
            id: `${local.kind}:${local.version || 'unknown'}`,
            kind: local.kind,
            version: local.version || 'unknown',
            name: local.name,
            directory: local.directory,
            binaryDirectory: local.binaryDirectory,
            installed: true,
            installable: false,
            releaseUrl: '',
          }
        : undefined);
    if (!entry?.installed || !entry.directory) throw new Error('error.toolVersionNotInstalled');
    if (!TOOL_KINDS.includes(entry.kind)) throw new Error('error.toolVersionUnsupported');
    this.log('status.exportTool', entry.name);
    this.log('status.exportSourceDirectory', entry.directory);
    this.log('status.exportPlatform', `${this.platform}/${this.arch}`);
    const directory = path.join(this.options.dataRoot, 'exports');
    await fs.mkdir(directory, { recursive: true });
    const stage = await fs.mkdtemp(path.join(directory, 'tool-export-'));
    let created = '';
    try {
      this.progress(entry.name, 'starting');
      const staged = path.join(stage, 'snapshot.zip');
      const info = await this.writeSnapshot(entry, staged);
      const id = randomUUID(),
        file = path.join(directory, id + '.zip');
      await fs.rename(staged, file);
      created = file;
      const name = `blode-${entry.id.replace(/[^A-Za-z0-9_.-]/g, '-')}-${this.platform}-${this.arch}-snapshot.zip`;
      const result: ToolPackageResult = {
        id,
        name,
        size: info.size,
        sha256: info.sha256,
        toolId: request.id,
        platform: this.platform,
        arch: this.arch,
      };
      this.artifacts.set(id, { path: file, name });
      try {
        await fs.writeFile(path.join(directory, id + '.tool.json'), JSON.stringify(result));
      } catch (error) {
        this.artifacts.delete(id);
        throw error;
      }
      created = '';
      this.log('status.exportArchiveName', name);
      this.log('status.exportElapsed', `${((performance.now() - started) / 1000).toFixed(2)} s`);
      this.progress(entry.name, 'completed');
      return result;
    } finally {
      if (created) {
        await fs.unlink(created).catch(() => {});
        await fs.unlink(created.replace(/\.zip$/, '.tool.json')).catch(() => {});
      }
      if (inside(directory, stage))
        await fs.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  async download(request: { id: string; confirm: true }): Promise<ToolPackageResult> {
    if (request.confirm !== true) throw new Error('error.invalidArguments');
    const entry = (await new ToolVersions(this.options).catalog()).find((item) => item.id === request.id);
    if (!entry?.installable) throw new Error('error.toolVersionUnsupported');
    const directory = path.join(this.options.dataRoot, 'exports');
    await fs.mkdir(directory, { recursive: true });
    const stage = await fs.mkdtemp(path.join(directory, 'tool-download-'));
    const records: Record[] = [];
    let total = 0,
      artifact = '';
    const save = async (
      url: string,
      name: string,
      role: Record['role'],
      expected?: string,
      size?: number,
      destination?: string,
    ) => {
      const rel = `payload/${records.length}-${name.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
        file = path.join(stage, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const current = await this.writeResponse(
        await this.response(url),
        file,
        `${entry.name} · ${name}`,
        size,
      );
      if (
        (expected && current.sha256 !== expected.toLowerCase()) ||
        (size !== undefined && current.size !== size) ||
        (role === 'metadata' && current.size > 8_000_000) ||
        (role === 'index' && current.size > 40_000_000) ||
        (total += current.size) > MAX_TOTAL
      )
        throw new Error('error.toolPackageChecksum');
      const item = { path: rel, url, ...current, role, ...(destination ? { destination } : {}) };
      records.push(item);
      return { item, file };
    };
    const metadata = async (url: string, name: string, role: Record['role'] = 'metadata') => {
      const saved = await save(url, name, role);
      if (saved.item.size > 20_000_000) throw new Error('error.toolPackageInvalid');
      return { value: JSON.parse(await fs.readFile(saved.file, 'utf8')), saved };
    };
    try {
      this.progress(entry.name, 'starting');
      if (entry.kind === 'gnu-arm' || entry.kind === 'arduino-cli') {
        const release =
          entry.kind === 'gnu-arm'
            ? gnuRelease(entry.version, this.platform, this.arch)
            : arduinoCliAsset(entry.version, this.platform, this.arch);
        if (!release) throw new Error('error.toolVersionUnsupported');
        const { value } = await metadata(release.metadataUrl, 'release.json');
        const asset = value.assets?.find(
          (item: any) => item.name === release.asset && item.browser_download_url === release.downloadUrl,
        );
        if (value.tag_name !== `v${entry.version}` || value.draft || value.prerelease || !asset)
          throw new Error('error.toolVersionRelease');
        let expected = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')?.[1];
        if (!expected) {
          const checksumName =
            entry.kind === 'gnu-arm' ? `${release.asset}.sha` : `${entry.version}-checksums.txt`;
          const checksum = value.assets?.find(
            (item: any) =>
              item.name === checksumName &&
              item.browser_download_url ===
                (entry.kind === 'gnu-arm'
                  ? release.downloadUrl + '.sha'
                  : `https://github.com/arduino/arduino-cli/releases/download/v${entry.version}/${checksumName}`),
          );
          if (!checksum) throw new Error('error.toolPackageChecksum');
          const saved = await save(checksum.browser_download_url, checksumName, 'metadata');
          const text = await fs.readFile(saved.file, 'utf8');
          expected = text
            .split(/\r?\n/)
            .map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim()))
            .find((match) => match?.[2] === release.asset)?.[1];
        }
        if (!expected) throw new Error('error.toolPackageChecksum');
        await save(release.downloadUrl, release.asset, 'archive', expected, asset.size);
      } else if (entry.kind === 'arduino-esp32') {
        const esp = await metadata(
          'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
          'package_esp32_index.json',
          'index',
        );
        const arduino = await metadata(
          'https://downloads.arduino.cc/packages/package_index.json',
          'package_index.json',
          'index',
        );
        const packages = [...(esp.value.packages ?? []), ...(arduino.value.packages ?? [])],
          owner = packages.find((item) => item.name === 'esp32');
        const core = owner?.platforms?.find(
          (item: any) => item.architecture === 'esp32' && item.version === entry.version,
        );
        if (!core) throw new Error('error.toolVersionRelease');
        const add = async (item: any, destination: string) => {
          const checksum = /^SHA-256:([a-f0-9]{64})$/i.exec(item.checksum ?? '')?.[1];
          if (!checksum || !/^https:\/\//.test(item.url)) throw new Error('error.toolPackageChecksum');
          await save(item.url, item.archiveFileName, 'archive', checksum, Number(item.size), destination);
        };
        await add(core, `arduino-data/packages/esp32/hardware/esp32/${entry.version}`);
        const hosts =
          this.platform === 'win32'
            ? ['x86_64-mingw32', 'i686-mingw32']
            : this.arch === 'arm64'
              ? ['aarch64-linux-gnu']
              : ['x86_64-pc-linux-gnu', 'x86_64-linux-gnu'];
        for (const dep of core.toolsDependencies ?? []) {
          const tool = packages
            .find((item) => item.name === dep.packager)
            ?.tools?.find((item: any) => item.name === dep.name && item.version === dep.version);
          const system = hosts
            .map((host) => tool?.systems?.find((item: any) => item.host === host))
            .find(Boolean);
          if (!system) throw new Error('error.toolVersionUnsupported');
          await add(system, `arduino-data/packages/${dep.packager}/tools/${dep.name}/${dep.version}`);
        }
      } else throw new Error('error.toolVersionUnsupported');
      const manifest: Manifest = {
        format: 'blode-tool-package',
        version: 1,
        toolId: entry.id,
        platform: this.platform,
        arch: this.arch,
        files: records,
      };
      schema.parse(manifest);
      const id = randomUUID(),
        file = path.join(directory, id + '.zip'),
        name = `blode-${entry.id.replace(':', '-')}-${this.platform}-${this.arch}.zip`;
      artifact = file;
      const entries: Array<ZipEntry | FileZipEntry> = [
        { path: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
        ...records.map((item) => ({ path: item.path, data: { file: path.join(stage, item.path) } })),
      ];
      this.progress(entry.name, 'verifying');
      await writeZip(
        file,
        (async function* () {
          yield* entries;
        })(),
        { signal: this.options.signal },
      );
      this.artifacts.set(id, { path: file, name });
      const result = {
        id,
        name,
        size: (await fs.stat(file)).size,
        sha256: await digest(file, this.options.signal),
        toolId: entry.id,
        platform: this.platform,
        arch: this.arch,
      };
      await fs.writeFile(path.join(directory, id + '.tool.json'), JSON.stringify(result));
      this.progress(entry.name, 'completed');
      return result;
    } catch (error) {
      if (artifact) {
        await fs.unlink(artifact).catch(() => {});
        await fs.unlink(artifact.replace(/\.zip$/, '.tool.json')).catch(() => {});
      }
      throw error;
    } finally {
      if (inside(directory, stage))
        await fs.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  downloadFile(id: string) {
    const file = this.artifacts.get(id);
    if (!file) throw new Error('error.packageExpired');
    return file;
  }
  private async preflight(archive: string, maxBytes = 4_000_000_000, maxEntries = 60000) {
    const settings = { signal: this.options.signal, timeout: 300000, env: this.options.env };
    const seen = new Map<string, string>();
    let count = 0,
      sizes = 0,
      error = '';
    const acceptName = (name: string) => {
      if (!name || name === '.' || name === './') return;
      if (++count > maxEntries || !safe(name.replace(/^\.\//, '').replace(/\/$/, '')))
        error = 'error.toolPackageExtract';
      const canonical = name.replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
      const prior = seen.get(canonical);
      if (prior && (!name.endsWith('/') || prior !== name)) error = 'error.toolPackageExtract';
      if (count <= maxEntries) seen.set(canonical, name);
    };
    const acceptDetails = (line: string) => {
      if (!line) return;
      if (!/^[d-]/.test(line) || / -> | link to /.test(line)) error = 'error.toolPackageExtract';
      const numbers = line
        .split(/\s+/)
        .slice(1, 6)
        .filter((value) => /^\d+$/.test(value))
        .map(Number);
      sizes += Math.max(0, ...numbers);
      if (sizes > maxBytes) error = 'error.toolPackageInvalid';
    };
    let receivedNames = false,
      receivedDetails = false;
    const listing = await this.options.runner(this.tarCommand, ['-tf', archive], {
      ...settings,
      onLine: (line) => {
        receivedNames = true;
        acceptName(line);
      },
    });
    if (!receivedNames) {
      if (listing.output.length >= 1_999_000) throw new Error('error.toolPackageExtract');
      listing.output.split(/\r?\n/).forEach(acceptName);
    }
    const verbose = await this.options.runner(this.tarCommand, ['-tvf', archive], {
      ...settings,
      onLine: (line) => {
        receivedDetails = true;
        acceptDetails(line);
      },
    });
    if (!receivedDetails) {
      if (verbose.output.length >= 1_999_000) throw new Error('error.toolPackageExtract');
      verbose.output.split(/\r?\n/).forEach(acceptDetails);
    }
    if (listing.code || verbose.code) throw new Error('error.toolPackageExtract');
    if (error) throw new Error(error);
    return { size: sizes, count };
  }
  private async extract(
    archive: string,
    destination: string,
    maxBytes = 4_000_000_000,
    maxEntries = 60000,
    charge = true,
  ) {
    const estimate = await this.preflight(archive, maxBytes, maxEntries);
    if (charge) {
      this.extractedBytes += estimate.size;
      this.extractedCount += estimate.count;
      if (this.extractedBytes > 4_000_000_000 || this.extractedCount > 60000)
        throw new Error('error.toolPackageInvalid');
    }
    const settings = { signal: this.options.signal, timeout: 300000, env: this.options.env };
    await fs.mkdir(destination, { recursive: true });
    const extracted = await this.options.runner(this.tarCommand, ['-xf', archive, '-C', destination], {
      ...settings,
      onLine: this.options.onLine,
    });
    if (extracted.code) throw new Error('error.toolPackageExtract');
    let total = 0,
      count = 0;
    const verify = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++count > 60000 || entry.isSymbolicLink()) throw new Error('error.toolPackageExtract');
        const file = path.join(directory, entry.name);
        if (!inside(destination, file)) throw new Error('error.toolPackageExtract');
        if (entry.isDirectory()) await verify(file);
        else if (entry.isFile()) {
          total += (await fs.stat(file)).size;
          if (total > 4_000_000_000) throw new Error('error.toolPackageInvalid');
        } else throw new Error('error.toolPackageExtract');
      }
    };
    await verify(destination);
  }
  private async packageVerification(unpack: string): Promise<PackageVerification> {
    const snapshot = path.join(unpack, SNAPSHOT);
    if (await this.exists(snapshot)) {
      if ((await fs.stat(snapshot)).size > 50_000_000) throw new Error('error.toolPackageInvalid');
      const manifest = snapshotSchema.parse(JSON.parse(await fs.readFile(snapshot, 'utf8')));
      return verifyPackageDirectory(
        path.join(unpack, 'files'),
        { kind: 'tool', id: manifest.toolId, version: manifest.toolVersion },
        { signal: this.options.signal },
      );
    }
    return verifyPackageDirectory(unpack, { kind: 'tool' }, { signal: this.options.signal });
  }
  async inspect(source: string): Promise<PackageVerification> {
    if (!path.isAbsolute(source)) throw new Error('error.invalidArguments');
    const parent = path.join(this.options.root, 'offline-imports');
    await fs.mkdir(parent, { recursive: true });
    const stage = await fs.mkdtemp(path.join(parent, 'review-'));
    try {
      const info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PACKAGE)
        throw new Error('error.toolPackageInvalid');
      this.extractedBytes = 0;
      this.extractedCount = 0;
      const unpack = path.join(stage, 'package');
      await this.extract(source, unpack, MAX_PACKAGE, SNAPSHOT_ENTRIES + 2, false);
      return await this.packageVerification(unpack);
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  async install(request: {
    path: string;
    confirm: true;
    approval?: PackageApproval;
  }): Promise<ToolVersionsState> {
    this.operation = 'install';
    this.extractedBytes = 0;
    this.extractedCount = 0;
    if (request.confirm !== true || !path.isAbsolute(request.path)) throw new Error('error.invalidArguments');
    const directory = path.join(this.options.root, 'offline-imports');
    await fs.mkdir(directory, { recursive: true });
    const stage = await fs.mkdtemp(path.join(directory, 'package-'));
    try {
      const stat = await fs.lstat(request.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PACKAGE)
        throw new Error('error.toolPackageInvalid');
      this.progress('offline-tool', 'extracting');
      const unpack = path.join(stage, 'package');
      await this.extract(request.path, unpack, MAX_PACKAGE, SNAPSHOT_ENTRIES + 2, false);
      const verification = await this.packageVerification(unpack);
      if (this.options.enforceSignatures || request.approval)
        assertPackageApproval(verification, request.approval);
      const snapshotManifest = path.join(unpack, SNAPSHOT);
      if (await this.exists(snapshotManifest))
        return await this.installSnapshot(unpack, snapshotManifest, verification.status === 'tampered');
      const manifestFile = path.join(unpack, MANIFEST);
      if (!(await this.exists(manifestFile))) throw new Error('error.toolPackageInvalid');
      if ((await fs.stat(manifestFile)).size > 1_000_000) throw new Error('error.toolPackageInvalid');
      const text = await fs.readFile(manifestFile, 'utf8');
      let manifest: Manifest;
      try {
        manifest = schema.parse(JSON.parse(text));
      } catch {
        throw new Error('error.toolPackageInvalid');
      }
      if (manifest.platform !== this.platform || manifest.arch !== this.arch)
        throw new Error('error.toolPackagePlatform');
      const tools = new ToolVersions(this.options),
        entry = (await tools.catalog()).find((item) => item.id === manifest.toolId);
      if (!entry?.installable) throw new Error('error.toolVersionUnsupported');
      this.progress(entry.name, 'verifying');
      if (
        new Set(manifest.files.map((item) => item.url)).size !== manifest.files.length ||
        new Set(manifest.files.map((item) => item.path.toLowerCase())).size !== manifest.files.length
      )
        throw new Error('error.toolPackageInvalid');
      let outerCount = 0;
      const countOuter = async (directory: string) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await countOuter(file);
          else {
            outerCount++;
            if (
              file !== manifestFile &&
              file !== path.join(unpack, 'obe') &&
              !manifest.files.some((item) => path.join(unpack, item.path) === file)
            )
              throw new Error('error.toolPackageInvalid');
          }
        }
      };
      await countOuter(unpack);
      if (outerCount !== manifest.files.length + 1 + Number(await this.exists(path.join(unpack, 'obe'))))
        throw new Error('error.toolPackageIncomplete');
      let total = 0;
      for (const item of manifest.files) {
        this.options.signal?.throwIfAborted();
        const file = path.join(unpack, item.path),
          info = await fs.lstat(file);
        total += info.size;
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          (item.role === 'metadata' && info.size > 8_000_000) ||
          (item.role === 'index' && info.size > 40_000_000) ||
          total > MAX_TOTAL ||
          info.size !== item.size ||
          (await digest(file, this.options.signal)) !== item.sha256
        )
          throw new Error('error.toolPackageChecksum');
        if (item.role === 'archive') await this.preflight(file);
      }
      const toolRoot = path.join(stage, 'tools');
      if (entry.kind === 'arduino-esp32') await this.installEsp(entry, manifest, unpack, toolRoot);
      else {
        const fetcher: typeof fetch = async (input) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const item = manifest.files.find((item) => item.url === url);
          if (!item) throw new Error('error.toolPackageIncomplete');
          return new Response(
            Readable.toWeb(createReadStream(path.join(unpack, item.path))) as ReadableStream,
            { status: 200, headers: { 'content-length': String(item.size) } },
          );
        };
        await new ToolVersions({
          ...this.options,
          root: toolRoot,
          fetcher,
          onProgress: (progress) =>
            this.options.onProgress?.({
              ...progress,
              operation: 'install',
              phase: progress.phase === 'downloading' ? 'verifying' : progress.phase,
            }),
        }).toolVersionInstall({ id: entry.id, confirm: true });
      }
      const source = path.join(toolRoot, 'versions', entry.kind, entry.version),
        destination = path.join(this.options.root, 'versions', entry.kind, entry.version);
      await repairInstalledToolIntegrity(source, stage, this.options.runner, this.options.signal);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if ((await tools.catalog()).find((item) => item.id === entry.id)?.installed)
        return tools.toolVersionsState();
      if (!inside(await fs.realpath(this.options.root), await fs.realpath(path.dirname(destination))))
        throw new Error('error.toolPackageExtract');
      const backup = path.join(stage, 'previous');
      const exists = await fs.lstat(destination).catch(() => null);
      if (exists?.isSymbolicLink()) throw new Error('error.toolPackageExtract');
      if (exists) await fs.rename(destination, backup);
      try {
        this.options.signal?.throwIfAborted();
        await fs.rename(source, destination);
      } catch (error) {
        if (exists) await fs.rename(backup, destination);
        throw error;
      }
      this.progress(entry.name, 'completed');
      return tools.toolVersionsState();
    } finally {
      if (inside(directory, stage))
        await fs.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  private async validSnapshot(kind: SnapshotManifest['kind'], version: string, directory: string) {
    const executable = (name: string) =>
      path.join(directory, 'bin', name + (this.platform === 'win32' ? '.exe' : ''));
    if (kind === 'stlink') return this.exists(executable('st-info'));
    if (kind === 'armcc')
      return (
        await Promise.all(
          ['armcc', 'armasm', 'armlink', 'fromelf'].map((name) => this.exists(executable(name))),
        )
      ).every(Boolean);
    if (kind === 'armclang')
      return (
        await Promise.all(['armclang', 'armlink', 'fromelf'].map((name) => this.exists(executable(name))))
      ).every(Boolean);
    if (kind === 'gnu-arm')
      return (
        (await this.exists(executable('arm-none-eabi-gcc'))) &&
        (await this.exists(executable('arm-none-eabi-objcopy')))
      );
    if (kind === 'arduino-cli') return this.exists(executable('arduino-cli'));
    if (kind === 'clangd') return this.exists(executable('clangd'));
    if (kind === 'arduino-esp32')
      return (
        (await this.exists(path.join(directory, 'installed.json'))) &&
        (await this.exists(path.join(directory, 'arduino-cli.yaml'))) &&
        (await this.exists(
          path.join(
            directory,
            'arduino-data',
            'packages',
            'esp32',
            'hardware',
            'esp32',
            version,
            'platform.txt',
          ),
        ))
      );
    return false;
  }
  private async installSnapshot(unpack: string, manifestFile: string, allowModified = false) {
    const info = await fs.stat(manifestFile).catch(() => null);
    // The manifest may describe up to 60,000 SDK files with SHA-256 and long paths.
    if (!info?.isFile() || info.size > 48_000_000) throw new Error('error.toolPackageInvalid');
    let manifest: SnapshotManifest;
    try {
      manifest = snapshotSchema.parse(JSON.parse(await fs.readFile(manifestFile, 'utf8')));
    } catch {
      throw new Error('error.toolPackageInvalid');
    }
    if (manifest.platform !== this.platform || manifest.arch !== this.arch)
      throw new Error('error.toolPackagePlatform');
    const tools = new ToolVersions(this.options);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(manifest.toolVersion) ||
      manifest.toolId !== `${manifest.kind}:${manifest.toolVersion}`
    )
      throw new Error('error.toolVersionUnknown');
    const entry: SnapshotTool = (await tools.catalog()).find((item) => item.id === manifest.toolId) ?? {
      id: manifest.toolId,
      kind: manifest.kind,
      version: manifest.toolVersion,
      name: `${manifest.kind} ${manifest.toolVersion}`,
      installed: false,
      installable: false,
      releaseUrl: '',
    };
    const destination = path.join(this.options.root, 'versions', entry.kind, entry.version);
    if (entry.installed || (await this.validSnapshot(entry.kind, entry.version, destination)))
      return tools.toolVersionsState();
    this.progress(entry.name, 'verifying');
    const expected = new Map<string, SnapshotManifest['files'][number]>();
    for (const item of manifest.files) {
      if (expected.has(item.path.toLowerCase())) throw new Error('error.toolPackageInvalid');
      expected.set(item.path.toLowerCase(), item);
    }
    const payload = path.join(unpack, 'files');
    let total = 0,
      seen = 0;
    const visit = async (current: string, prefix: string) => {
      for (const item of await fs.readdir(current, { withFileTypes: true })) {
        this.options.signal?.throwIfAborted();
        const file = path.join(current, item.name),
          relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (!safe(relative) || item.isSymbolicLink()) throw new Error('error.toolPackageExtract');
        if (item.isDirectory()) {
          await visit(file, relative);
          continue;
        }
        const record = expected.get(relative.toLowerCase());
        if (!item.isFile() || !record) throw new Error('error.toolPackageInvalid');
        const stat = await fs.lstat(file);
        total += stat.size;
        if (
          !stat.isFile() ||
          (!allowModified && stat.size !== record.size) ||
          total > SNAPSHOT_TOTAL ||
          (!allowModified && (await digest(file, this.options.signal)) !== record.sha256)
        )
          throw new Error('error.toolPackageChecksum');
        if (record.mode !== undefined && this.platform !== 'win32') await fs.chmod(file, record.mode);
        seen++;
      }
    };
    await visit(payload, '');
    if (seen !== manifest.files.length || !(await this.validSnapshot(entry.kind, entry.version, payload)))
      throw new Error('error.toolPackageIncomplete');
    if (entry.kind === 'arduino-esp32')
      await fs.writeFile(
        path.join(payload, 'arduino-cli.yaml'),
        JSON.stringify({
          directories: {
            data: path.join(destination, 'arduino-data'),
            downloads: path.join(destination, 'downloads'),
            user: path.join(destination, 'libraries'),
          },
        }),
      );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (!inside(await fs.realpath(this.options.root), await fs.realpath(path.dirname(destination))))
      throw new Error('error.toolPackageExtract');
    const backup = path.join(unpack, '..', 'previous');
    const exists = await fs.lstat(destination).catch(() => null);
    if (exists?.isSymbolicLink()) throw new Error('error.toolPackageExtract');
    if (exists) await fs.rename(destination, backup);
    try {
      this.options.signal?.throwIfAborted();
      await fs.rename(payload, destination);
    } catch (error) {
      if (exists) await fs.rename(backup, destination);
      throw error;
    }
    this.progress(entry.name, 'completed');
    return tools.toolVersionsState();
  }
  private async installEsp(entry: ToolVersionEntry, manifest: Manifest, unpack: string, toolRoot: string) {
    const directory = path.join(toolRoot, 'versions', entry.kind, entry.version);
    const packages: any[] = [];
    for (const url of [
      'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
      'https://downloads.arduino.cc/packages/package_index.json',
    ]) {
      const index = manifest.files.find((item) => item.role === 'index' && item.url === url);
      if (!index) throw new Error('error.toolPackageIncomplete');
      const value = JSON.parse(await fs.readFile(path.join(unpack, index.path), 'utf8'));
      packages.push(...(value.packages ?? []));
    }
    const platform = packages
      .find((item) => item.name === 'esp32')
      ?.platforms?.find((item: any) => item.architecture === 'esp32' && item.version === entry.version);
    if (!platform) throw new Error('error.toolPackageIncomplete');
    const required = [
      { value: platform, destination: `arduino-data/packages/esp32/hardware/esp32/${entry.version}` },
    ];
    const hosts =
      this.platform === 'win32'
        ? ['x86_64-mingw32', 'i686-mingw32']
        : this.arch === 'arm64'
          ? ['aarch64-linux-gnu']
          : ['x86_64-pc-linux-gnu', 'x86_64-linux-gnu'];
    for (const dep of platform.toolsDependencies ?? []) {
      const tool = packages
        .find((item) => item.name === dep.packager)
        ?.tools?.find((item: any) => item.name === dep.name && item.version === dep.version);
      const system = hosts
        .map((host) => tool?.systems?.find((item: any) => item.host === host))
        .find(Boolean);
      if (!system) throw new Error('error.toolPackageIncomplete');
      required.push({
        value: system,
        destination: `arduino-data/packages/${dep.packager}/tools/${dep.name}/${dep.version}`,
      });
    }
    const archives = manifest.files.filter((item) => item.role === 'archive');
    if (
      archives.length !== required.length ||
      required.some(
        ({ value, destination }) =>
          !archives.some(
            (item) =>
              item.url === value.url &&
              item.destination === destination &&
              item.size === Number(value.size) &&
              `SHA-256:${item.sha256}`.toLowerCase() === String(value.checksum).toLowerCase(),
          ),
      )
    )
      throw new Error('error.toolPackageIncomplete');
    for (const item of manifest.files) {
      if (item.role === 'archive') {
        if (
          !item.destination ||
          !/^arduino-data\/packages\/[A-Za-z0-9_-]+\/(?:hardware|tools)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.+-]+$/.test(
            item.destination,
          )
        )
          throw new Error('error.toolPackageInvalid');
        const extract = path.join(
          toolRoot,
          'extract-' + createHash('sha256').update(item.path).digest('hex').slice(0, 8),
        );
        await this.extract(path.join(unpack, item.path), extract);
        const files = await fs.readdir(extract, { withFileTypes: true });
        const root =
          files.length === 1 && files[0].isDirectory() ? path.join(extract, files[0].name) : extract;
        const target = path.join(directory, item.destination);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(root, target);
      } else if (item.role === 'index') {
        await fs.mkdir(path.join(directory, 'arduino-data'), { recursive: true });
        const name = item.url.includes('espressif') ? 'package_esp32_index.json' : 'package_index.json';
        await fs.copyFile(path.join(unpack, item.path), path.join(directory, 'arduino-data', name));
      }
    }
    if (
      !(
        await fs
          .stat(
            path.join(
              directory,
              'arduino-data',
              'packages',
              'esp32',
              'hardware',
              'esp32',
              entry.version,
              'platform.txt',
            ),
          )
          .catch(() => null)
      )?.isFile()
    )
      throw new Error('error.toolPackageIncomplete');
    const installedDirectory = path.join(this.options.root, 'versions', entry.kind, entry.version);
    await fs.writeFile(
      path.join(directory, 'arduino-cli.yaml'),
      JSON.stringify({
        directories: {
          data: path.join(installedDirectory, 'arduino-data'),
          downloads: path.join(installedDirectory, 'downloads'),
          user: path.join(installedDirectory, 'libraries'),
        },
      }),
    );
    await fs.writeFile(
      path.join(directory, 'installed.json'),
      JSON.stringify({ version: entry.version, installedAt: new Date().toISOString(), offline: true }),
    );
  }
}
