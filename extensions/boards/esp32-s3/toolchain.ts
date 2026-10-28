import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectConfig, ToolchainStatus } from '../../../src/shared/contracts.js';
import type { RuntimeHost, RuntimeCommandResult } from '../../runtime.js';

const ESP32_INDEX = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json';
type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] };

export class Toolchains {
  private cached: ToolchainStatus | null = null;
  private readonly root: string;
  private readonly bin: string;
  private readonly configFile: string;
  constructor(
    private readonly runCommand: RuntimeHost['runCommand'],
    private readonly dataRoot: string,
    private readonly log: (message: string) => void,
    private readonly network: { fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
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
    await fs.mkdir(this.root, { recursive: true });
    const directories = {
      data: path.join(this.root, 'arduino-data'),
      downloads: path.join(this.root, 'downloads'),
      user: path.join(this.root, 'libraries'),
    };
    for (const directory of Object.values(directories)) await fs.mkdir(directory, { recursive: true });
    // JSON is valid YAML; JSON quoting preserves Windows backslashes safely.
    const proxyEnv = this.network.env ?? process.env;
    const proxy = proxyEnv.https_proxy || proxyEnv.HTTPS_PROXY || proxyEnv.http_proxy || proxyEnv.HTTP_PROXY;
    await fs.writeFile(
      this.configFile,
      JSON.stringify(
        {
          directories,
          board_manager: { additional_urls: [...new Set([ESP32_INDEX, ...config.toolchain.additionalUrls])] },
          ...(proxy ? { network: { proxy } } : {}),
        },
        null,
        2,
      ),
    );
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

  async status(config: ProjectConfig, refresh = false): Promise<ToolchainStatus> {
    if (this.cached && !refresh) return structuredClone(this.cached);
    const cli = await this.cliPath(config);
    const python = await this.pythonPath(config);
    const [cliVersion, pythonVersion, esptoolVersion] = await Promise.all([
      this.commandExists(cli, ['version']),
      this.commandExists(python, ['--version']),
      this.commandExists(python, ['-m', 'esptool', 'version']),
    ]);
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
    if (config.toolchain.mode === 'custom') {
      const current = await this.status(config, true);
      if (!current.arduinoCli) throw new Error('error.toolchainMissing');
      // A supplied CLI uses the same isolated package store and HTTPS board indexes.
      const update = await this.runCli(config, ['core', 'update-index'], 300_000);
      if (update.code !== 0) throw new Error(update.output || 'error.toolchainIndex');
      const install = await this.runCli(config, ['core', 'install', 'esp32:esp32'], 1_200_000);
      if (install.code !== 0) throw new Error(install.output || 'error.toolchainCore');
      const status = await this.status(config, true);
      await fs.writeFile(
        path.join(this.root, 'toolchain.lock.json'),
        JSON.stringify(
          { installedAt: new Date().toISOString(), mode: 'custom', ...status.versions },
          null,
          2,
        ),
      );
      return status;
    }
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
    const bytes = await downloadArchive(
      [`https://downloads.arduino.cc/arduino-cli/${asset.name}`, asset.browser_download_url],
      fetcher,
      this.network.signal,
    );
    if (
      bytes.length > 100_000_000 ||
      createHash('sha256').update(bytes).digest('hex') !== checksum.toLowerCase()
    )
      throw new Error('error.toolchainChecksum');
    await fs.writeFile(archive, bytes);
    const extraction = await this.runCommand('tar', ['-xf', archive, '-C', this.bin], {
      timeout: 60_000,
      onLine: this.log,
      signal: this.network.signal,
    });
    if (extraction.code !== 0) throw new Error(extraction.output || 'error.toolchainExtract');
    if (process.platform !== 'win32') await fs.chmod(await this.cliPath(config), 0o755);
    await fs.unlink(archive);
    const update = await this.runCli(config, ['core', 'update-index'], 300_000);
    if (update.code !== 0) throw new Error(update.output || 'error.toolchainIndex');
    this.log('status.installingEsp32');
    const install = await this.runCli(config, ['core', 'install', 'esp32:esp32'], 1_200_000);
    if (install.code !== 0) throw new Error(install.output || 'error.toolchainCore');
    let python = await this.pythonPath(config);
    const esptool = await this.commandExists(python, ['-m', 'esptool', 'version']);
    if (!esptool) {
      if (config.toolchain.python) throw new Error('error.esptoolMissing');
      const systemPython = config.toolchain.python || (process.platform === 'win32' ? 'python' : 'python3');
      const venv = await this.runCommand(systemPython, ['-m', 'venv', path.join(this.root, 'python')], {
        timeout: 120_000,
        onLine: this.log,
        signal: this.network.signal,
      });
      if (venv.code !== 0) throw new Error(venv.output || 'error.pythonMissing');
      python = await this.pythonPath(config);
      const pip = await this.runCommand(python, ['-m', 'pip', 'install', '--upgrade', 'esptool'], {
        timeout: 300_000,
        onLine: this.log,
        env: this.network.env,
        signal: this.network.signal,
      });
      if (pip.code !== 0) throw new Error(pip.output || 'error.esptoolInstall');
    }
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

async function downloadArchive(urls: string[], fetcher: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
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
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of response.body) {
          total += chunk.byteLength;
          if (total > 100_000_000) throw new Error('error.toolchainArchiveSize');
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = error;
      }
    }
  }
  throw failure;
}
