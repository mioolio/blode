import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverId, DriverState, DriverStatus } from '../shared/contracts';
import { getDriverDefinition, listDriverDefinitions } from '../../extensions/drivers/index';
import type { DriverDefinition } from '../../extensions/drivers/types';
import { runCommand } from './process';

export interface DriverOptions {
  /** Directory that contains the bundled driver archives, normally `tools/STSW-LINK`. */
  archiveRoot: string;
  /** Writable application data directory; extracted installers stay under `drivers/`. */
  dataRoot: string;
  log: (message: string, level?: 'info' | 'error') => void;
  signal?: AbortSignal;
}

export interface DriverDevice {
  status?: string;
  problem?: number;
  friendlyName?: string;
  instanceId?: string;
}

/** A probe is usable when at least one matching device reports no PnP problem code. */
export function resolveDriverState(installed: boolean, devices: DriverDevice[]): DriverState {
  if (!devices.length) return installed ? 'installed' : 'missing';
  return devices.some((device) => Number(device.problem ?? 0) === 0) ? 'ready' : 'device-unbound';
}

export function parseDriverVersion(text: string): string {
  const match = text.match(/DriverVer\s*=\s*([^,\r\n]+),\s*([^\r\n]+)/i);
  return match?.[2]?.trim() ?? '';
}

/**
 * Windows debug-probe drivers are machine-wide, so they live in the core rather than a
 * board adapter. Board support only asks whether the probe is ready; it never shells out.
 */
export class Drivers {
  private cache: DriverStatus[] | null = null;
  private checkedAt = 0;

  constructor(private readonly options: DriverOptions) {}

  async statuses(refresh = false): Promise<DriverStatus[]> {
    if (!refresh && this.cache && Date.now() - this.checkedAt < 5_000) return structuredClone(this.cache);
    const values = await Promise.all(listDriverDefinitions().map((definition) => this.statusFor(definition)));
    this.cache = values;
    this.checkedAt = Date.now();
    return structuredClone(values);
  }

  async install(id: DriverId): Promise<DriverStatus[]> {
    const definition = getDriverDefinition(id);
    if (process.platform !== 'win32') throw new Error('error.driverUnsupported');
    const archive = path.join(this.options.archiveRoot, definition.archive);
    if (!(await exists(archive))) throw new Error('error.driverPackageMissing');
    const work = path.join(this.options.dataRoot, 'drivers', definition.id);
    // Only the fixed per-user extraction directory is cleared; never a caller-supplied path.
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    this.options.log('status.driverExtracting');
    let extraction: Awaited<ReturnType<typeof runCommand>>;
    try {
      extraction = await runCommand('tar', ['-xf', archive, '-C', work], {
        timeout: 60_000,
        onLine: (line) => this.options.log(line),
        signal: this.options.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'error.operationCancelled') throw error;
      throw new Error('error.driverExtract');
    }
    if (extraction.code !== 0) {
      this.options.log(extraction.output.trim(), 'error');
      throw new Error('error.driverExtract');
    }
    for (const inf of definition.infFiles) {
      if (!(await exists(path.join(work, inf)))) throw new Error('error.driverPackageInvalid');
    }
    const resultFile = path.join(work, 'install-result.json');
    const elevationFile = path.join(work, 'elevation-error.txt');
    const elevated = buildElevatedScript(work, resultFile, definition.infFiles);
    const launcher = buildLauncher(elevated, elevationFile);
    this.options.log('status.driverInstalling');
    const run = await runCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(launcher, 'utf16le').toString('base64'),
      ],
      {
        timeout: 300_000,
        onLine: (line) => this.options.log(line),
        signal: this.options.signal,
      },
    );
    const elevation = (await fs.readFile(elevationFile, 'utf8').catch(() => '')).trim();
    if (elevation) {
      this.options.log(elevation);
      throw new Error(/cancel|取消/i.test(elevation) ? 'error.driverCancelled' : 'error.driverElevation');
    }
    const result = await readInstallResult(resultFile);
    if (!result) {
      if (run.output.trim()) this.options.log(run.output.trim(), 'error');
      throw new Error('error.driverInstallFailed');
    }
    for (const line of result.output.split(/\r?\n/))
      if (line.trim()) this.options.log(line, result.ok ? 'info' : 'error');
    if (!result.ok) throw new Error('error.driverInstallFailed');
    this.cache = null;
    this.options.log('status.driverInstalled');
    return this.statuses(true);
  }

  private async statusFor(definition: DriverDefinition): Promise<DriverStatus> {
    const supported = process.platform === 'win32';
    const available = await exists(path.join(this.options.archiveRoot, definition.archive));
    if (!supported)
      return {
        id: definition.id,
        name: definition.name,
        supported,
        installed: false,
        connected: false,
        deviceCount: 0,
        version: '',
        state: 'unsupported',
        available,
      };
    const [packageInfo, devices] = await Promise.all([
      this.installedPackage(definition),
      this.connectedDevices(definition),
    ]);
    return {
      id: definition.id,
      name: definition.name,
      supported,
      installed: !!packageInfo,
      connected: devices.length > 0,
      deviceCount: devices.length,
      version: packageInfo?.version ?? '',
      state: resolveDriverState(!!packageInfo, devices),
      available,
    };
  }

  /** The INF can be staged by Windows Update too, so the driver store is the source of truth. */
  private async installedPackage(definition: DriverDefinition): Promise<{ version: string } | null> {
    const repository = path.join(
      process.env.SystemRoot || process.env.windir || 'C:\\Windows',
      'System32',
      'DriverStore',
      'FileRepository',
    );
    const entries = await fs.readdir(repository).catch(() => [] as string[]);
    const entry = entries.find((name) => definition.storeEntry.test(name));
    if (!entry) return null;
    const directory = path.join(repository, entry);
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    const inf = files.find((name) => name.toLowerCase().endsWith('.inf'));
    if (!inf) return { version: '' };
    const text = await fs.readFile(path.join(directory, inf), 'utf8').catch(() => '');
    return { version: parseDriverVersion(text) };
  }

  private async connectedDevices(definition: DriverDefinition): Promise<DriverDevice[]> {
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$patterns = @(${definition.deviceIds.map((value) => `'${value}'`).join(', ')})`,
      '$items = @(Get-PnpDevice -PresentOnly | Where-Object {',
      '  $id = [string]$_.InstanceId',
      '  $found = $false',
      '  foreach ($pattern in $patterns) { if ($id -like "*$pattern*") { $found = $true; break } }',
      '  $found',
      "} | Select-Object @{n='status';e={[string]$_.Status}}, @{n='problem';e={[int]$_.Problem}},",
      "  @{n='friendlyName';e={[string]$_.FriendlyName}}, @{n='instanceId';e={[string]$_.InstanceId}})",
      '@{ devices = $items } | ConvertTo-Json -Compress -Depth 3',
    ].join('\n');
    let result: Awaited<ReturnType<typeof runCommand>>;
    try {
      result = await runCommand(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { timeout: 20_000, signal: this.options.signal },
      );
    } catch {
      // A missing or blocked PowerShell is a detection failure, not a state failure.
      return [];
    }
    if (result.code !== 0) return [];
    try {
      const parsed = JSON.parse(result.output.replace(/^\uFEFF/, '').trim()) as {
        devices?: DriverDevice | DriverDevice[];
      };
      if (!parsed.devices) return [];
      return Array.isArray(parsed.devices) ? parsed.devices : [parsed.devices];
    } catch {
      return [];
    }
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** pnputil is the supported Windows installer; the vendor's INF files stay untouched. */
export function buildElevatedScript(root: string, resultFile: string, infFiles: readonly string[]): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    `$root = ${quote(root)}`,
    `$resultFile = ${quote(resultFile)}`,
    '$lines = New-Object System.Collections.Generic.List[string]',
    '$ok = $true',
    'try {',
    `  foreach ($inf in @(${infFiles.map((value) => `"${value}"`).join(', ')})) {`,
    '    $output = & pnputil.exe /add-driver (Join-Path $root $inf) /install 2>&1 | Out-String',
    '    $code = $LASTEXITCODE',
    '    $lines.Add("$inf (exit $code)")',
    '    if ($output.Trim()) { $lines.Add($output.Trim()) }',
    '    if ($code -ne 0 -and $code -ne 3010) { $ok = $false }',
    '  }',
    '  & pnputil.exe /scan-devices 2>&1 | Out-Null',
    '} catch {',
    '  $ok = $false',
    '  $lines.Add(($_ | Out-String))',
    '}',
    '$payload = [ordered]@{ ok = $ok; output = ($lines -join "`n") }',
    '$payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultFile -Encoding UTF8',
    'if ($ok) { exit 0 } else { exit 1 }',
  ].join('\r\n');
}

/** The outer shell only elevates; results travel through the JSON file, not stdout. */
export function buildLauncher(elevated: string, elevationFile: string): string {
  const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}' -Verb RunAs -Wait`,
    '  exit 0',
    '} catch {',
    `  Set-Content -LiteralPath ${quote(elevationFile)} -Value ($_ | Out-String) -Encoding UTF8`,
    '  exit 1223',
    '}',
  ].join('\r\n');
}

async function readInstallResult(file: string): Promise<{ ok: boolean; output: string } | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as { ok?: unknown; output?: unknown };
    return { ok: parsed.ok === true, output: typeof parsed.output === 'string' ? parsed.output : '' };
  } catch {
    return null;
  }
}
