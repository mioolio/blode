import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { InstallationProgress, ProjectConfig, ProjectBuildInputs } from '../shared/contracts';
import {
  type LocalToolchain,
  type InstalledBuildTool,
  type ToolVersionEntry,
  type ToolVersionsApi,
  type ToolVersionsState,
} from '../shared/tool-versions';
import type { RuntimeHost } from '../../extensions/runtime';
import { GnuArmToolchain, gnuRelease } from '../../extensions/boards/STM32F103C8T6/tools/gnu';
import { toolVersionSchemas } from './tool-version-schemas';
import { discoverInstalledBuildTools } from './installed-tools';
import { readToolPackages } from './tool-package-store';
import { CLANGD_VERSION, clangdRelease, clangdExecutable } from './clangd/manifest';
import { installClangd } from './clangd/install';

const GNU_VERSIONS = ['15.2.1-1.1', '14.2.1-1.1', '13.3.1-1.1'];
const CLI_VERSIONS = ['1.3.1', '1.2.2'];
const ESP_VERSIONS = ['3.0.7', '2.0.17'];
const MAX_ARCHIVE = 100_000_000;
interface Options {
  root: string;
  dataRoot: string;
  config: () => ProjectConfig | Promise<ProjectConfig>;
  build?: () => ProjectBuildInputs | Promise<ProjectBuildInputs>;
  runner: RuntimeHost['runCommand'];
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  onProgress?: (progress: InstallationProgress) => void;
  platform?: NodeJS.Platform;
  arch?: string;
}
export function arduinoCliAsset(version: string, platform: NodeJS.Platform, arch: string) {
  if (!CLI_VERSIONS.includes(version)) throw new Error('error.toolVersionUnknown');
  const target =
    platform === 'win32' && arch === 'x64'
      ? 'Windows_64bit.zip'
      : platform === 'linux' && arch === 'x64'
        ? 'Linux_64bit.tar.gz'
        : platform === 'linux' && arch === 'arm64'
          ? 'Linux_ARM64.tar.gz'
          : null;
  if (!target) return null;
  const asset = `arduino-cli_${version}_${target}`;
  return {
    asset,
    metadataUrl: `https://api.github.com/repos/arduino/arduino-cli/releases/tags/v${version}`,
    downloadUrl: `https://github.com/arduino/arduino-cli/releases/download/v${version}/${asset}`,
  };
}

/** Side-by-side host tools. Selecting a version returns explicit existing compiler/store paths. */
export class ToolVersions implements Pick<
  ToolVersionsApi,
  'toolVersionsState' | 'toolVersionInstall' | 'toolVersionSelect'
> {
  private readonly root: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private busy = false;
  constructor(private readonly options: Options) {
    this.root = path.join(path.resolve(options.root), 'versions');
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }
  private get tarCommand() {
    if (this.platform !== 'win32') return 'tar';
    const systemRoot = this.options.env?.SystemRoot ?? process.env.SystemRoot;
    return systemRoot ? path.join(systemRoot, 'System32', 'tar.exe') : 'tar';
  }
  private directory(kind: string, version: string) {
    return path.join(this.root, kind, version);
  }
  private executable(name: string) {
    return name + (this.platform === 'win32' ? '.exe' : '');
  }
  private async exists(file: string) {
    const stat = await fs.lstat(file).catch(() => null);
    return !!stat?.isFile() && !stat.isSymbolicLink();
  }
  private async entries(): Promise<ToolVersionEntry[]> {
    const entries: ToolVersionEntry[] = [];
    for (const version of GNU_VERSIONS) {
      let downloadUrl: string | undefined;
      try {
        downloadUrl = gnuRelease(version, this.platform, this.arch).downloadUrl;
      } catch {}
      const directory = this.directory('gnu-arm', version);
      entries.push({
        id: `gnu-arm:${version}`,
        kind: 'gnu-arm',
        version,
        name: `GNU Arm GCC ${version}`,
        releaseUrl: `https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/releases/tag/v${version}`,
        downloadUrl,
        installable: !!downloadUrl,
        installed:
          (await this.exists(path.join(directory, 'bin', this.executable('arm-none-eabi-gcc')))) &&
          (await this.exists(path.join(directory, 'bin', this.executable('arm-none-eabi-objcopy')))),
        directory,
      });
    }
    for (const version of CLI_VERSIONS) {
      const asset = arduinoCliAsset(version, this.platform, this.arch);
      const directory = this.directory('arduino-cli', version);
      entries.push({
        id: `arduino-cli:${version}`,
        kind: 'arduino-cli',
        version,
        name: `Arduino CLI ${version}`,
        releaseUrl: `https://github.com/arduino/arduino-cli/releases/tag/v${version}`,
        downloadUrl: asset?.downloadUrl,
        installable: !!asset,
        installed: await this.exists(path.join(directory, 'bin', this.executable('arduino-cli'))),
        directory,
      });
    }
    for (const version of ESP_VERSIONS) {
      const directory = this.directory('arduino-esp32', version);
      entries.push({
        id: `arduino-esp32:${version}`,
        kind: 'arduino-esp32',
        version,
        name: `Arduino-ESP32 ${version}`,
        releaseUrl: `https://github.com/espressif/arduino-esp32/releases/tag/${version}`,
        downloadUrl: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
        installable: ['win32', 'linux'].includes(this.platform) && ['x64', 'arm64'].includes(this.arch),
        installed: await this.exists(path.join(directory, 'installed.json')),
        directory,
      });
    }
    entries.push({
      id: 'stlink:1.9.0',
      kind: 'stlink',
      version: '1.9.0',
      name: 'ST-Link 1.9.0',
      releaseUrl: 'https://github.com/stlink-org/stlink/releases/tag/v1.9.0',
      downloadUrl:
        this.platform === 'linux' && this.arch === 'x64'
          ? 'https://github.com/stlink-org/stlink/releases/download/v1.9.0/stlink_1.9.0-1_amd64.deb'
          : undefined,
      installable: false,
      installed: false,
      note: 'settings.versions.stlinkSystem',
    });
    {
      const release = clangdRelease(this.platform, this.arch);
      const versioned = this.directory('clangd', CLANGD_VERSION);
      const directory = (await this.exists(path.join(versioned, 'bin', clangdExecutable(this.platform))))
        ? versioned
        : path.join(this.options.root, 'clangd');
      entries.push({
        id: `clangd:${CLANGD_VERSION}`,
        kind: 'clangd',
        version: CLANGD_VERSION,
        name: `clangd ${CLANGD_VERSION}`,
        releaseUrl: release?.releaseUrl ?? 'https://clangd.llvm.org/installation',
        downloadUrl: release?.downloadUrl,
        installable: !!release,
        installed: await this.exists(path.join(directory, 'bin', clangdExecutable(this.platform))),
        directory,
      });
    }
    return entries;
  }
  catalog() {
    return this.entries();
  }
  async toolVersionsState(): Promise<ToolVersionsState> {
    const [entries, installedTools] = await Promise.all([this.entries(), this.installedTools()]);
    return {
      platform: this.platform,
      arch: this.arch,
      entries,
      installedTools,
      localTools: await this.localTools(entries, installedTools),
      archives: await readToolPackages(this.options.dataRoot),
    };
  }
  private async localTools(
    entries: ToolVersionEntry[],
    installed: InstalledBuildTool[],
  ): Promise<LocalToolchain[]> {
    const identity = (value: string) =>
      this.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const inside = (value: string, root: string) => {
      const relative = path.relative(identity(root), identity(value));
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const result: LocalToolchain[] = entries
      .filter((entry) => entry.installed)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        kind: entry.kind,
        directory: entry.directory,
        source: inside(entry.directory!, this.root) ? 'versioned' : 'managed',
        exportable: true,
        binaryDirectory: entry.directory && path.join(entry.directory, 'bin'),
      }));
    const add = (tool: Omit<LocalToolchain, 'id'>, id?: string) => {
      if (
        !tool.directory ||
        result.some(
          (entry) =>
            entry.kind === tool.kind &&
            entry.directory &&
            identity(entry.directory) === identity(tool.directory!),
        )
      )
        return;
      result.push({
        ...tool,
        id:
          id ??
          `local:${tool.kind}:${createHash('sha256').update(identity(tool.directory)).digest('hex').slice(0, 24)}`,
      });
    };
    for (const tool of installed) {
      if (tool.family !== 'arduino') {
        const directory =
          tool.directory &&
          (path.basename(tool.directory).toLowerCase() === 'bin'
            ? path.dirname(tool.directory)
            : tool.directory);
        add(
          {
            name: tool.name,
            version: tool.version,
            kind: tool.family,
            directory,
            source: tool.source,
            exportable: !!directory,
            binaryDirectory: tool.directory,
          },
          tool.id,
        );
      } else {
        if (tool.arduinoCli) {
          const binaryDirectory = path.dirname(tool.arduinoCli);
          const directory =
            path.basename(binaryDirectory).toLowerCase() === 'bin'
              ? path.dirname(binaryDirectory)
              : binaryDirectory;
          const cliVersion = tool.name.match(/Arduino CLI ([\d.]+)/)?.[1] ?? '';
          add({
            name: `Arduino CLI ${cliVersion}`.trim(),
            version: cliVersion,
            kind: 'arduino-cli',
            directory,
            source: tool.source,
            exportable: true,
            binaryDirectory,
          });
        }
        add({
          name: `Arduino-ESP32 ${tool.version}`,
          version: tool.version,
          kind: 'arduino-esp32',
          directory: tool.packageDirectory,
          source: tool.source,
          exportable: !!tool.packageDirectory,
        });
      }
    }
    const config = await this.options.config();
    const cliFile = config.toolchain.arduinoCli?.trim();
    const cliCandidates = [
      path.join(this.options.root, 'bin', this.executable('arduino-cli')),
      ...(cliFile && path.isAbsolute(cliFile) ? [cliFile] : []),
    ];
    for (const file of new Set(cliCandidates)) {
      const managed = identity(file) === identity(cliCandidates[0]);
      const binaryDirectory = path.dirname(file);
      const directory =
        path.basename(binaryDirectory).toLowerCase() === 'bin'
          ? path.dirname(binaryDirectory)
          : binaryDirectory;
      if (
        result.some(
          (entry) =>
            entry.kind === 'arduino-cli' &&
            entry.directory &&
            (identity(entry.directory) === identity(directory) ||
              identity(path.join(entry.directory, 'bin', this.executable('arduino-cli'))) === identity(file)),
        )
      )
        continue;
      if (!(await this.exists(file))) continue;
      const probe = await this.options
        .runner(file, ['version'], { timeout: 4000, signal: this.options.signal, env: this.options.env })
        .catch(() => ({ code: -1, output: '' }));
      const version = probe.code === 0 ? probe.output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] : undefined;
      if (version)
        add({
          name: `Arduino CLI ${version}`,
          version,
          kind: 'arduino-cli',
          directory,
          source: managed ? 'managed' : 'custom',
          exportable: true,
          binaryDirectory,
        });
    }
    const versionRoot = path.join(this.root, 'stlink');
    const versions = (await fs.readdir(versionRoot, { withFileTypes: true }).catch(() => []))
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .slice(0, 64)
      .map((item) => path.join(versionRoot, item.name, 'bin'));
    const stlinkBins = [
      config.toolchain.stlinkDirectory?.trim(),
      path.join(this.options.root, 'stlink', 'bin'),
      ...versions,
    ].filter((value): value is string => !!value && path.isAbsolute(value));
    for (const stlinkBin of new Set(stlinkBins)) {
      if (!(await this.exists(path.join(stlinkBin, this.executable('st-info'))))) continue;
      const probe = await this.options
        .runner(path.join(stlinkBin, this.executable('st-info')), ['--version'], {
          timeout: 4000,
          signal: this.options.signal,
          env: this.options.env,
        })
        .catch(() => ({ code: -1, output: '' }));
      if (probe.code === 0)
        add({
          name: 'ST-Link',
          version: probe.output.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? '',
          kind: 'stlink',
          directory: path.basename(stlinkBin).toLowerCase() === 'bin' ? path.dirname(stlinkBin) : stlinkBin,
          binaryDirectory: stlinkBin,
          source: config.toolchain.stlinkDirectory ? 'custom' : 'managed',
          exportable: true,
        });
    }
    return result;
  }
  private async installedTools() {
    return discoverInstalledBuildTools({
      root: this.options.root,
      config: await this.options.config(),
      build: await this.options.build?.(),
      runner: this.options.runner,
      platform: this.platform,
      env: this.options.env,
      signal: this.options.signal,
    });
  }
  private async entry(id: string) {
    const entry = (await this.entries()).find((item) => item.id === id);
    if (!entry) throw new Error('error.toolVersionUnknown');
    return entry;
  }
  async toolVersionSelect(input: { id: string }): Promise<Partial<ProjectConfig['toolchain']>> {
    const { id } = toolVersionSchemas.select.parse(input);
    if (id.startsWith('installed:')) {
      const installed = (await this.installedTools()).find((item) => item.id === id);
      if (!installed) throw new Error('error.toolVersionNotInstalled');
      return installed.family === 'arduino'
        ? { mode: 'custom', arduinoCli: installed.arduinoCli, packageDirectory: installed.packageDirectory }
        : { armCompilerDirectory: installed.directory };
    }
    const entry = await this.entry(id);
    if (!entry.installed || !entry.directory) throw new Error('error.toolVersionNotInstalled');
    if (entry.kind === 'gnu-arm') return { armCompilerDirectory: path.join(entry.directory, 'bin') };
    if (entry.kind === 'arduino-cli')
      return {
        mode: 'custom',
        arduinoCli: path.join(entry.directory, 'bin', this.executable('arduino-cli')),
      };
    if (entry.kind === 'arduino-esp32') return { packageDirectory: entry.directory };
    if (entry.kind === 'clangd') return {};
    throw new Error('error.toolVersionUnknown');
  }
  private progress(tool: string, phase: InstallationProgress['phase']) {
    this.options.onProgress?.({ tool, phase });
  }
  private async response(url: string): Promise<Response> {
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, AbortSignal.timeout(600_000)])
      : AbortSignal.timeout(600_000);
    const response = await (this.options.fetcher ?? fetch)(url, {
      signal,
      headers: { 'User-Agent': 'Blode-Studio' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response;
  }
  private async installCli(entry: ToolVersionEntry) {
    const expected = arduinoCliAsset(entry.version, this.platform, this.arch);
    if (!expected) throw new Error('error.toolVersionUnsupported');
    this.progress(entry.name, 'starting');
    const release = (await (await this.response(expected.metadataUrl)).json()) as {
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: { name: string; browser_download_url: string; digest?: string; size?: number }[];
    };
    const asset = release.assets?.find(
      (item) => item.name === expected.asset && item.browser_download_url === expected.downloadUrl,
    );
    if (release.tag_name !== `v${entry.version}` || release.draft || release.prerelease || !asset)
      throw new Error('error.toolVersionRelease');
    let digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase();
    if (!digest) {
      const checksums = release.assets?.find(
        (item) =>
          item.name === `${entry.version}-checksums.txt` &&
          item.browser_download_url ===
            `https://github.com/arduino/arduino-cli/releases/download/v${entry.version}/${entry.version}-checksums.txt`,
      );
      if (!checksums) throw new Error('error.toolVersionChecksum');
      const text = await (await this.response(checksums.browser_download_url)).text();
      if (text.length > 100_000) throw new Error('error.toolVersionChecksum');
      digest = text
        .split(/\r?\n/)
        .map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim()))
        .find((match) => match?.[2] === expected.asset)?.[1]
        ?.toLowerCase();
    }
    if (
      !digest ||
      (asset.size !== undefined &&
        (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ARCHIVE))
    )
      throw new Error('error.toolVersionChecksum');
    const response = await this.response(expected.downloadUrl);
    if (!response.body) throw new Error('error.toolVersionChecksum');
    const chunks: Buffer[] = [];
    let size = 0,
      last = 0;
    const progress = () =>
      this.options.onProgress?.({
        tool: entry.name,
        phase: 'downloading',
        receivedBytes: size,
        totalBytes: asset.size,
      });
    progress();
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_ARCHIVE) throw new Error('error.toolVersionChecksum');
      chunks.push(Buffer.from(chunk));
      if (Date.now() - last > 500) {
        progress();
        last = Date.now();
      }
    }
    progress();
    this.progress(entry.name, 'verifying');
    const bytes = Buffer.concat(chunks);
    if (
      createHash('sha256').update(bytes).digest('hex') !== digest ||
      (asset.size !== undefined && size !== asset.size)
    )
      throw new Error('error.toolVersionChecksum');
    await fs.mkdir(entry.directory!, { recursive: true });
    const stage = await fs.mkdtemp(path.join(entry.directory!, '.install-'));
    try {
      const archive = path.join(stage, expected.asset);
      await fs.writeFile(archive, bytes);
      const listing = await this.options.runner(this.tarCommand, ['-tf', archive], {
        signal: this.options.signal,
        timeout: 60_000,
      });
      if (
        listing.code !== 0 ||
        listing.output
          .split(/\r?\n/)
          .some((item) => /^(?:[\/\\]|[a-z]:)|(?:^|[\/\\])\.\.(?:[\/\\]|$)|\0/i.test(item))
      )
        throw new Error('error.toolVersionExtract');
      const bin = path.join(entry.directory!, 'bin');
      await fs.mkdir(bin, { recursive: true });
      this.progress(entry.name, 'extracting');
      const result = await this.options.runner(this.tarCommand, ['-xf', archive, '-C', bin], {
        signal: this.options.signal,
        timeout: 120_000,
        onLine: this.options.onLine,
      });
      if (result.code !== 0 || !(await this.exists(path.join(bin, this.executable('arduino-cli')))))
        throw new Error('error.toolVersionExtract');
      if (this.platform !== 'win32') await fs.chmod(path.join(bin, 'arduino-cli'), 0o755);
      const version = await this.options.runner(path.join(bin, this.executable('arduino-cli')), ['version'], {
        signal: this.options.signal,
        timeout: 15_000,
      });
      if (version.code !== 0 || !version.output.includes(entry.version))
        throw new Error('error.toolVersionExtract');
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
  private async installEsp(entry: ToolVersionEntry) {
    const config = await this.options.config();
    const cli =
      config.toolchain.arduinoCli ||
      path.join(path.resolve(this.options.root), 'bin', this.executable('arduino-cli'));
    const executable = (await this.exists(cli)) ? cli : 'arduino-cli';
    const directory = entry.directory!;
    await fs.mkdir(directory, { recursive: true });
    const configuration = path.join(directory, 'arduino-cli.yaml');
    await fs.writeFile(
      configuration,
      JSON.stringify({
        directories: {
          data: path.join(directory, 'arduino-data'),
          downloads: path.join(directory, 'downloads'),
          user: path.join(directory, 'libraries'),
        },
        board_manager: {
          additional_urls: [
            'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
            ...config.toolchain.additionalUrls,
          ],
        },
      }),
    );
    for (const [args, phase] of [
      [['core', 'update-index'], 'downloading'],
      [['core', 'install', `esp32:esp32@${entry.version}`], 'installing'],
    ] as const) {
      this.progress(entry.name, phase);
      const result = await this.options.runner(executable, [...args, '--config-file', configuration], {
        signal: this.options.signal,
        timeout: 1_200_000,
        env: this.options.env,
        onLine: this.options.onLine,
      });
      if (result.code !== 0) throw new Error(result.output || 'error.toolVersionInstall');
    }
    const result = await this.options.runner(
      executable,
      ['core', 'list', '--json', '--config-file', configuration],
      { signal: this.options.signal, timeout: 30_000, env: this.options.env },
    );
    let parsed;
    try {
      parsed = JSON.parse(result.output);
    } catch {
      throw new Error('error.toolVersionInstall');
    }
    const cores = Array.isArray(parsed) ? parsed : (parsed.platforms ?? []);
    if (
      result.code !== 0 ||
      !cores.some(
        (core: { id?: string; installed?: string; installed_version?: string; version?: string }) =>
          core.id === 'esp32:esp32' &&
          (core.installed_version ?? core.installed ?? core.version) === entry.version,
      )
    )
      throw new Error('error.toolVersionInstall');
    await fs.writeFile(
      path.join(directory, 'installed.json'),
      JSON.stringify({ version: entry.version, installedAt: new Date().toISOString() }),
    );
  }
  async toolVersionInstall(input: { id: string; confirm: true }): Promise<ToolVersionsState> {
    const { id } = toolVersionSchemas.install.parse(input);
    if (this.busy) throw new Error('error.busy');
    this.busy = true;
    try {
      const entry = await this.entry(id);
      if (!entry.installable) throw new Error('error.toolVersionUnsupported');
      if (entry.installed) return this.toolVersionsState();
      if (entry.kind === 'gnu-arm')
        await new GnuArmToolchain({
          root: entry.directory!,
          runner: this.options.runner,
          fetcher: this.options.fetcher,
          signal: this.options.signal,
          onLine: this.options.onLine,
          onProgress: this.options.onProgress,
          release: gnuRelease(entry.version, this.platform, this.arch),
        }).install();
      else if (entry.kind === 'arduino-cli') await this.installCli(entry);
      else if (entry.kind === 'clangd')
        await installClangd({
          directory: entry.directory!,
          platform: this.platform,
          arch: this.arch,
          fetcher: this.options.fetcher,
          signal: this.options.signal,
          onLine: this.options.onLine,
          onProgress: (progress) =>
            this.options.onProgress?.({
              tool: entry.name,
              phase: progress.phase,
              receivedBytes: progress.receivedBytes,
              totalBytes: progress.totalBytes,
            }),
        });
      else await this.installEsp(entry);
      this.progress(entry.name, 'completed');
      return this.toolVersionsState();
    } finally {
      this.busy = false;
    }
  }
}
