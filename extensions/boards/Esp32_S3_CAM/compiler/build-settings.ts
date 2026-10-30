import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BuildSettings, CompilerChoice } from '../../../../src/shared/build-settings.js';
import type { ProjectConfig } from '../../../../src/shared/contracts.js';
import type { RuntimeHost } from '../../../runtime.js';

export function compilerChoice(settings: BuildSettings | undefined, language: 'c' | 'cpp'): CompilerChoice {
  let selected: CompilerChoice = { family: 'inherit' };
  const platform = settings?.platforms?.['Esp32_S3_CAM'];
  for (const layer of [settings?.common, platform?.common, platform?.[language]]) {
    if (!layer) continue;
    selected = layer.family === 'inherit' ? { ...selected, ...layer, family: selected.family } : { ...layer };
  }
  return selected;
}

export function optimizationFlags(settings?: BuildSettings): string[] {
  return [settings?.mode === 'debug' ? '-O0' : settings?.optimizeForSize === false ? '-O2' : '-Os', '-g'];
}

export async function compilerConfig(
  host: RuntimeHost,
  config: ProjectConfig,
  choice: CompilerChoice,
): Promise<ProjectConfig> {
  if (choice.family === 'gnu-arm' || choice.family === 'armclang')
    throw new Error('error.buildCompilerPlatform');
  if (choice.version && !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/.test(choice.version))
    throw new Error('error.buildCompilerVersion');
  for (const value of [choice.directory, choice.arduinoCli, choice.packageDirectory])
    if (value && (!path.isAbsolute(value) || /[\0\r\n]/.test(value)))
      throw new Error('error.buildCompilerPath');
  const root = host.toolchainRoot ?? path.join(host.dataRoot, 'toolchains');
  const toolchain = {
    ...config.toolchain,
    ...(choice.family === 'auto'
      ? { mode: 'managed' as const, arduinoCli: '', packageDirectory: undefined }
      : {}),
  };
  let cli = choice.arduinoCli;
  if (choice.directory) {
    cli = undefined;
    for (const directory of [path.join(choice.directory, 'bin'), choice.directory]) {
      const candidate = path.join(
        directory,
        process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli',
      );
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) {
        cli = candidate;
        break;
      }
    }
    if (!cli) throw new Error('error.buildCompilerPath');
  }
  if (cli) {
    const stat = await fs.stat(cli).catch(() => null);
    if (!stat?.isFile()) throw new Error('error.buildCompilerPath');
    toolchain.mode = 'custom';
    toolchain.arduinoCli = cli;
  }
  let store = choice.packageDirectory;
  if (!store && choice.version) {
    for (const candidate of new Set([
      path.join(root, 'versions', 'arduino-esp32', choice.version),
      toolchain.packageDirectory ?? root,
      root,
    ])) {
      const core = path.join(candidate, 'arduino-data/packages/esp32/hardware/esp32', choice.version);
      const stat = await fs.lstat(core).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        store = candidate;
        break;
      }
    }
    if (!store) throw new Error('error.buildCompilerVersion');
  }
  if (store) {
    const stat = await fs.lstat(store).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error(choice.version ? 'error.buildCompilerVersion' : 'error.buildCompilerPath');
    toolchain.packageDirectory = store;
  }
  if (choice.version) {
    const core = path.join(
      toolchain.packageDirectory ?? root,
      'arduino-data/packages/esp32/hardware/esp32',
      choice.version,
    );
    const stat = await fs.lstat(core).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('error.buildCompilerVersion');
  }
  return { ...config, toolchain };
}

export function compilerIdentity(host: RuntimeHost, config: ProjectConfig): string {
  const root = host.toolchainRoot ?? path.join(host.dataRoot, 'toolchains');
  const cli =
    config.toolchain.mode === 'custom'
      ? config.toolchain.arduinoCli || 'arduino-cli'
      : path.join(root, 'bin', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
  const identity = JSON.stringify([
    path.normalize(cli),
    path.resolve(config.toolchain.packageDirectory ?? root),
  ]);
  return process.platform === 'win32' ? identity.toLowerCase() : identity;
}
