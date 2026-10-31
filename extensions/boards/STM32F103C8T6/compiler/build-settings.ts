import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BuildSettings, CompilerChoice } from '../../../../src/shared/build-settings.js';
import type { ProjectConfig } from '../../../../src/shared/contracts.js';
import type { RuntimeHost } from '../../../runtime.js';

/** An explicit family starts a new pin; inherit preserves its parent's selection. */
export function compilerChoice(settings: BuildSettings | undefined, language: 'c' | 'cpp'): CompilerChoice {
  let selected: CompilerChoice = { family: 'inherit' };
  const platform = settings?.platforms?.STM32F103C8T6;
  for (const layer of [settings?.common, platform?.common, platform?.[language]]) {
    if (!layer) continue;
    if (layer.family === 'inherit') selected = { ...selected, ...layer, family: selected.family };
    else selected = { ...layer };
  }
  return selected;
}

export function optimizationFlags(settings?: BuildSettings): string[] {
  return [settings?.mode === 'debug' ? '-O0' : settings?.optimizeForSize === false ? '-O2' : '-Os', '-g'];
}

/** A portable version pin can match managed, side-by-side, custom, or PATH tools. */
export async function installedCompilerRoots(
  host: RuntimeHost,
  config: ProjectConfig,
  family: 'gnu-arm' | 'armclang' | 'armcc',
  version: string,
): Promise<string[]> {
  const root = host.toolchainRoot ?? path.join(host.dataRoot, 'toolchains');
  const store = path.join(root, 'versions', family);
  const entries = (await fs.readdir(store, { withFileTypes: true }).catch(() => []))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/.test(entry.name),
    )
    .sort(
      (a, b) =>
        Number(b.name.startsWith(version)) - Number(a.name.startsWith(version)) ||
        b.name.localeCompare(a.name, 'en', { numeric: true }),
    )
    .slice(0, 64);
  const searchPath = host.env?.PATH ?? host.env?.Path ?? process.env.PATH ?? process.env.Path ?? '';
  return [
    ...new Set([
      path.join(store, version),
      ...entries.map((entry) => path.join(store, entry.name)),
      ...(config.toolchain.armCompilerDirectory ? [config.toolchain.armCompilerDirectory] : []),
      path.join(root, family === 'gnu-arm' ? 'armgcc' : family),
      ...searchPath
        .split(path.delimiter)
        .map((value) => value.trim().replace(/^"(.*)"$/, '$1'))
        .filter((value) => path.isAbsolute(value))
        .slice(0, 64),
    ]),
  ];
}
