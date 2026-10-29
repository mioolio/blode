import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { InstallationProgress, ProjectConfig, ToolchainStatus } from '../../../src/shared/contracts.js';
import type { RuntimeHost, RuntimeCommandResult } from '../../runtime.js';

const ESP32_INDEX = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json';
type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] };

export class Toolchains {
  private cached: ToolchainStatus | null = null;
  private readonly root: string;
  private readonly bin: string;
  private configFile: string;
  constructor(
    private readonly runCommand: RuntimeHost['runCommand'],
    private readonly dataRoot: string,
    private readonly log: (message: string) => void,
    private readonly network: {
      fetcher?: typeof fetch;
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      onProgress?: (progress: InstallationProgress) => void;
    } = {},
    root?: string,
  ) {
    this.root = root ?? path.join(dataRoot, 'toolchains');
    this.bin = path.join(this.root, 'bin');
    this.configFile = path.join(this.root, 'arduino-cli.yaml');
  }

  async cliPath(config: ProjectConfig): Promise<string> {
    if (config.toolchain.mode === 'custom') return config.toolchain.arduinoCli || 'arduino-cli';
    return path.join(this.bin, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
  }

  async pythonPath(config: ProjectConfig): Promise<string> {
    if (config.toolchain.python) return config.toolchain.python;
    const candidates = [
      path.join(this.root, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      path.join(
        process.cwd(),
        '.tools/esptool-venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
    ];
    for (const file of candidates)
      try {
        await fs.access(file);
        return file;
      } catch {
        /* Try next local runtime. */
      }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private async ensureConfig(config: ProjectConfig): Promise<void> {
    const store = config.toolchain.packageDirectory
      ? path.resolve(config.toolchain.packageDirectory)
      : this.root;
    const directories = {
      data: path.join(store, 'arduino-data'),
      downloads: path.join(store, 'downloads'),
      user: path.join(store, 'libraries'),
    };
    // A bundled tool root may be read-only; the CLI still needs its cache paths named.
    for (const directory of Object.values(directories))
      await fs.mkdir(directory, { recursive: true }).catch(() => {});
    // JSON is valid YAML; JSON quoting preserves Windows backslashes safely.
    const proxyEnv = this.network.env ?? process.env;
    const proxy = proxyEnv.https_proxy || proxyEnv.HTTPS_PROXY || proxyEnv.http_proxy || proxyEnv.HTTP_PROXY;
    const contents = JSON.stringify(
      {
        directories,
        board_manager: { additional_urls: [...new Set([ESP32_INDEX, ...config.toolchain.additionalUrls])] },
        ...(proxy ? { network: { proxy } } : {}),
      },
      null,
      2,
    );
    try {
      await fs.mkdir(store, { recursive: true });
      this.configFile = path.join(store, 'arduino-cli.yaml');
      await fs.writeFile(this.configFile, contents);
    } catch {
      // The bundled tools folder cannot be written; keep configuration in user data.
      const fallback = path.join(this.dataRoot, 'toolchains');
      await fs.mkdir(fallback, { recursive: true });
      this.configFile = path.join(fallback, 'arduino-cli.yaml');
      await fs.writeFile(this.configFile, contents);
    }
  }

  async runCli(
    config: ProjectConfig,
    args: string[],
    timeout = 300_000,
    quiet = false,
  ): Promise<RuntimeCommandResult> {
    await this.ensureConfig(config);
    return this.runCommand(await this.cliPath(config), [...args, '--config-file', this.configFile], {
      timeout,
      onLine: quiet ? undefined : this.log,
      env: this.network.env,
      signal: this.network.signal,
    });
  }

  /** Runs esptool through Python when present, otherwise through the executable shipped by the ESP32 core. */
  async runEsptool(
    config: ProjectConfig,
    args: string[],
    options: { timeout: number; onLine?: (line: string) => void },
  ): Promise<RuntimeCommandResult> {
    const python = await this.pythonPath(config);
    const settings = { ...options, env: this.network.env, signal: this.network.signal };
    if (await this.commandExists(python, ['-m', 'esptool', 'version']))
      return this.runCommand(python, args, settings);
    // Both callers build args as `-m esptool <rest>`; a standalone binary takes `<rest>` directly.
    const bundled = args[0] === '-m' && args[1] === 'esptool' ? await this.bundledEsptool(config) : null;
    if (!bundled) return this.runCommand(python, args, settings);
    return this.runCommand(bundled, args.slice(2), settings);
  }

  async status(config: ProjectConfig, refresh = false): Promise<ToolchainStatus> {
    if (this.cached && !refresh) return structuredClone(this.cached);
    const cli = await this.cliPath(config);
    const python = await this.pythonPath(config);
    const bundledEsptool = await this.bundledEsptool(config);
    const [cliVersion, pythonVersion, moduleEsptool, bundledVersion] = await Promise.all([
      this.commandExists(cli, ['version']),
      this.commandExists(python, ['--version']),
      this.commandExists(python, ['-m', 'esptool', 'version']),
      bundledEsptool ? this.commandExists(bundledEsptool, ['version']) : Promise.resolve(null),
    ]);
    const esptoolVersion = moduleEsptool ?? bundledVersion;
    let esp32Core = false;
    let coreVersion = '';
    if (cliVersion) {
      try {
        const installed = await this.runCli(config, ['core', 'list', '--json'], 20_000, true);
        const parsed = JSON.parse(installed.output);
        const platforms = Array.isArray(parsed) ? parsed : (parsed.platforms ?? []);
        const core = platforms.find((item: { id?: string }) => item.id === 'esp32:esp32');
        esp32Core = !!core;
        coreVersion =
          typeof core?.installed_version === 'string'
            ? core.installed_version
            : typeof core?.installed === 'string'
              ? core.installed
              : typeof core?.version === 'string'
                ? core.version
                : '';
      } catch {
        /* Missing cores are a setup state, not an application error. */
      }
    }
    this.cached = {
      arduinoCli: !!cliVersion,
      esp32Core,
      python: !!pythonVersion,
      esptool: !!esptoolVersion,
      versions: {
        ...(cliVersion ? { arduinoCli: cliVersion } : {}),
        ...(pythonVersion ? { python: pythonVersion } : {}),
        ...(esptoolVersion ? { esptool: esptoolVersion } : {}),
        ...(coreVersion ? { esp32: coreVersion } : {}),
      },
    };
    return structuredClone(this.cached);
  }

  invalidate(): void {
    this.cached = null;
  }

  /** The ESP32 core bundle contains a standalone esptool; it keeps flashing usable without Python. */
  private async bundledEsptool(config: ProjectConfig): Promise<string | null> {
    const executable = process.platform === 'win32' ? 'esptool.exe' : 'esptool';
    const root = path.join(
      config.toolchain.packageDirectory ?? this.root,
      'arduino-data',
      'packages',
      'esp32',
      'tools',
      'esptool_py',
    );
    const versions = await fs.readdir(root).catch(() => [] as string[]);
    for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const file = path.join(root, version, executable);
      const found = await fs.access(file).then(
        () => true,
        () => false,
      );
      if (found) return file;
    }
    return null;
  }

  private async commandExists(command: string, args: string[]): Promise<string | null> {
    try {
      const result = await this.runCommand(command, args, {
        timeout: 12_000,
        env: this.network.env,
        signal: this.network.signal,
      });
      return result.code === 0 ? result.output.trim() : null;
    } catch (error) {
      if (this.network.signal?.aborted) throw error;
      return null;
    }
  }

  /** Only official stable releases are managed. A lock records the exact resolved versions. */
  async install(config: ProjectConfig): Promise<ToolchainStatus> {
    let coreTarget = 'esp32:esp32';
    if (config.toolchain.packageDirectory) {
      try {
        const selected = JSON.parse(
          await fs.readFile(path.join(config.toolchain.packageDirectory, 'installed.json'), 'utf8'),
        ) as { version?: string };
        if (typeof selected.version === 'string' && /^\d+\.\d+\.\d+$/.test(selected.version))
          coreTarget += `@${selected.version}`;
      } catch {
        /* A custom empty package store uses the normal stable release. */
      }
    }
    const progress = (tool: string, phase: InstallationProgress['phase']) =>
      this.network.onProgress?.({ tool, phase });
    if (config.toolchain.mode === 'custom') {
      progress('Arduino-ESP32', 'starting');
      const current = await this.status(config, true);
      if (!current.arduinoCli) throw new Error('error.toolchainMissing');
      // A supplied CLI uses the same isolated package store and HTTPS board indexes.
      progress('Arduino-ESP32 index', 'downloading');
      const update = await this.runCli(config, ['core', 'update-index'], 300_000);
      if (update.code !== 0) throw new Error(update.output || 'error.toolchainIndex');
      progress('Arduino-ESP32', 'installing');
      const install = await this.runCli(config, ['core', 'install', coreTarget], 1_200_000);
      if (install.code !== 0) throw new Error(install.output || 'error.toolchainCore');
      progress('Arduino-ESP32', 'verifying');
      const status = await this.status(config, true);
      await fs.writeFile(
        path.join(this.root, 'toolchain.lock.json'),
        JSON.stringify(
          { installedAt: new Date().toISOString(), mode: 'custom', ...status.versions },
          null,
          2,
        ),
      );
      progress('Arduino-ESP32', 'completed');
      return status;
    }
    progress('Arduino CLI', 'starting');
    await fs.mkdir(this.bin, { recursive: true });
    this.log('status.resolvingToolchain');
    const fetcher = this.network.fetcher ?? fetch;
    const release = await fetchJson<Release>(
      'https://api.github.com/repos/arduino/arduino-cli/releases/latest',
      fetcher,
      this.network.signal,
    );
    const platform =
      process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const architecture = process.arch === 'arm64' ? 'ARM64' : '64bit';
    const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';
    const asset = release.assets.find(
      (item) => item.name.includes(`${platform}_${architecture}`) && item.name.endsWith(extension),
    );
    const checksumAsset = release.assets.find((item) => /checksums\.txt$/.test(item.name));
    if (!asset || !checksumAsset) throw new Error('error.toolchainRelease');
    const archive = path.join(this.root, asset.name);
    const checksumText = await fetchText(checksumAsset.browser_download_url, fetcher, this.network.signal);
    const checksumLine = checksumText.split(/\r?\n/).find((line) => line.trim().endsWith(asset.name));
    const checksum = checksumLine?.trim().split(/\s+/)[0];
    if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('error.toolchainChecksum');
    this.log(`status.downloading ${asset.name}`);
    progress('Arduino CLI', 'downloading');
    const bytes = await downloadArchive(
      [`https://downloads.arduino.cc/arduino-cli/${asset.name}`, asset.browser_download_url],
      fetcher,
      this.network.signal,
      (receivedBytes, totalBytes) =>
        this.network.onProgress?.({
          tool: 'Arduino CLI',
          phase: 'downloading',
          receivedBytes,
          totalBytes,
        }),
    );
    progress('Arduino CLI', 'verifying');
    if (
      bytes.length > 100_000_000 ||
      createHash('sha256').update(bytes).digest('hex') !== checksum.toLowerCase()
    )
      throw new Error('error.toolchainChecksum');
    await fs.writeFile(archive, bytes);
    progress('Arduino CLI', 'extracting');
    const extraction = await this.runCommand('tar', ['-xf', archive, '-C', this.bin], {
      timeout: 60_000,
      onLine: this.log,
      signal: this.network.signal,
    });
    if (extraction.code !== 0) throw new Error(extraction.output || 'error.toolchainExtract');
    if (process.platform !== 'win32') await fs.chmod(await this.cliPath(config), 0o755);
    await fs.unlink(archive);
    progress('Arduino CLI', 'completed');
    progress('Arduino-ESP32 index', 'downloading');
    const update = await this.runCli(config, ['core', 'update-index'], 300_000);
    if (update.code !== 0) throw new Error(update.output || 'error.toolchainIndex');
    this.log('status.installingEsp32');
    progress('Arduino-ESP32', 'installing');
    const install = await this.runCli(config, ['core', 'install', coreTarget], 1_200_000);
    if (install.code !== 0) throw new Error(install.output || 'error.toolchainCore');
    progress('Arduino-ESP32', 'completed');
    let python = await this.pythonPath(config);
    const esptool = await this.commandExists(python, ['-m', 'esptool', 'version']);
    if (!esptool) {
      if (config.toolchain.python) throw new Error('error.esptoolMissing');
      const systemPython = config.toolchain.python || (process.platform === 'win32' ? 'python' : 'python3');
      progress('Python', 'installing');
      const venv = await this.runCommand(systemPython, ['-m', 'venv', path.join(this.root, 'python')], {
        timeout: 120_000,
        onLine: this.log,
        signal: this.network.signal,
      });
      if (venv.code !== 0) throw new Error(venv.output || 'error.pythonMissing');
      progress('Python', 'completed');
      python = await this.pythonPath(config);
      progress('esptool', 'installing');
      const pip = await this.runCommand(
        python,
        ['-m', 'pip', 'install', '--progress-bar', 'on', '--upgrade', 'esptool'],
        {
          timeout: 300_000,
          onLine: this.log,
          env: this.network.env,
          signal: this.network.signal,
        },
      );
      if (pip.code !== 0) throw new Error(pip.output || 'error.esptoolInstall');
      progress('esptool', 'completed');
    }
    progress('ESP32-S3 toolchain', 'verifying');
    const status = await this.status(config, true);
    await fs.writeFile(
      path.join(this.root, 'toolchain.lock.json'),
      JSON.stringify(
        {
          installedAt: new Date().toISOString(),
          cliRelease: release.tag_name,
          cliSha256: checksum,
          ...status.versions,
        },
        null,
        2,
      ),
    );
    progress('ESP32-S3 toolchain', 'completed');
    return status;
  }
}

async function fetchText(url: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        headers: { 'User-Agent': 'Blode-Studio' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return await response.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
    }
  }
  throw failure;
}
async function fetchJson<T>(url: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await fetchText(url, fetcher, signal)) as T;
}

async function downloadArchive(
  urls: string[],
  fetcher: typeof fetch,
  signal?: AbortSignal,
  onProgress?: (receivedBytes: number, totalBytes?: number) => void,
): Promise<Buffer> {
  let failure: unknown;
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(url, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
            : AbortSignal.timeout(180_000),
          headers: { 'User-Agent': 'Blode-Studio' },
        });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${url}`);
        const headerSize = Number(response.headers.get('content-length'));
        const totalBytes =
          Number.isSafeInteger(headerSize) && headerSize > 0 && headerSize <= 100_000_000
            ? headerSize
            : undefined;
        onProgress?.(0, totalBytes);
        const chunks: Buffer[] = [];
        let total = 0;
        let lastProgress = Date.now();
        for await (const chunk of response.body) {
          total += chunk.byteLength;
          if (total > 100_000_000) throw new Error('error.toolchainArchiveSize');
          chunks.push(Buffer.from(chunk));
          if (Date.now() - lastProgress >= 500) {
            onProgress?.(total, totalBytes);
            lastProgress = Date.now();
          }
        }
        onProgress?.(total, totalBytes);
        return Buffer.concat(chunks);
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error;
      }
    }
  }
  throw failure;
}
