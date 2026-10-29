import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectConfig, ProjectBuildInputs } from '../shared/contracts';
import type { CompilerChoice } from '../shared/build-settings';
import type { InstalledBuildTool } from '../shared/tool-versions';
import type { RuntimeHost } from '../../extensions/runtime';

interface Options {
  root: string;
  config: ProjectConfig;
  runner: RuntimeHost['runCommand'];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  build?: ProjectBuildInputs;
}
type Source = InstalledBuildTool['source'];
interface Candidate {
  directory: string;
  source: Source;
  version?: string;
}
const precedence: Record<Source, number> = { custom: 0, versioned: 1, managed: 2, path: 3 };

/** Inspect only declared installation roots and PATH, without invoking an installer. */
export async function discoverInstalledBuildTools(options: Options): Promise<InstalledBuildTool[]> {
  const root = path.resolve(options.root);
  const platform = options.platform ?? process.platform;
  const suffix = platform === 'win32' ? '.exe' : '';
  const identity = (value: string) =>
    platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  const env = { ...process.env, ...options.env };
  const choices: CompilerChoice[] = [
    ...(options.build?.settings?.common ? [options.build.settings.common] : []),
    ...Object.values(options.build?.settings?.platforms ?? {}).flatMap((settings) =>
      [settings?.common, settings?.c, settings?.cpp].filter((value): value is CompilerChoice => !!value),
    ),
  ];
  const paths = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((value) => value.trim().replace(/^"(.*)"$/, '$1'))
    .filter((value) => path.isAbsolute(value));
  const regular = async (file: string) => {
    const info = await fs.stat(file).catch(() => null);
    return !!info?.isFile();
  };
  const versions = async (kind: string): Promise<Candidate[]> => {
    const directory = path.join(root, 'versions', kind);
    const info = await fs.lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return [];
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^[\w.+-]{1,80}$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
      .slice(0, 64)
      .map((entry) => ({
        directory: path.join(directory, entry.name),
        source: 'versioned',
        version: entry.name,
      }));
  };
  const [gnuVersions, cliVersions, coreVersions] = await Promise.all([
    versions('gnu-arm'),
    versions('arduino-cli'),
    versions('arduino-esp32'),
  ]);
  const commands = new Map<string, Promise<string>>();
  const version = (file: string, cli = false) => {
    const key = `${identity(file)}\0${cli}`;
    let pending = commands.get(key);
    if (!pending) {
      pending = (async () => {
        if (options.signal?.aborted || !(await regular(file))) return '';
        try {
          const result = await options.runner(file, [cli ? 'version' : '--version'], {
            timeout: 10_000,
            signal: options.signal,
            env: options.env,
          });
          if (result.code !== 0) return '';
          return (
            /(?:Version:\s*|Arm Compiler for Embedded\s+)?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/i.exec(
              result.output,
            )?.[1] ?? ''
          );
        } catch (error) {
          if (options.signal?.aborted) throw error;
          return '';
        }
      })();
      commands.set(key, pending);
    }
    return pending;
  };
  const installed = new Map<string, InstalledBuildTool>();
  const add = (tool: Omit<InstalledBuildTool, 'id'>) => {
    const key = [
      tool.family,
      tool.directory ? identity(tool.directory) : '',
      tool.arduinoCli ? identity(tool.arduinoCli) : '',
      tool.packageDirectory ? identity(tool.packageDirectory) : '',
    ].join('\0');
    const old = installed.get(key);
    if (old && precedence[old.source] <= precedence[tool.source]) return;
    installed.set(key, {
      ...tool,
      id: `installed:${tool.family}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
    });
  };
  const customCompiler = options.config.toolchain.armCompilerDirectory?.trim();
  const compilerRoots: Candidate[] = [
    ...(customCompiler && path.isAbsolute(customCompiler)
      ? [{ directory: path.resolve(customCompiler), source: 'custom' as const }]
      : []),
    ...choices
      .filter(
        (choice) =>
          choice.directory &&
          path.isAbsolute(choice.directory) &&
          ['gnu-arm', 'armclang'].includes(choice.family),
      )
      .map((choice) => ({ directory: path.resolve(choice.directory!), source: 'custom' as const })),
    { directory: path.join(root, 'armclang'), source: 'managed' as const },
    { directory: path.join(root, 'armgcc'), source: 'managed' as const },
    ...gnuVersions,
    ...paths.map((directory) => ({ directory, source: 'path' as const })),
  ];
  const checkedCompilers = new Set<string>();
  for (const candidate of compilerRoots) {
    for (const directory of [...new Set([path.join(candidate.directory, 'bin'), candidate.directory])]) {
      for (const [family, required, title] of [
        ['armclang', ['armclang', 'armlink', 'fromelf'], 'Arm Compiler'],
        ['gnu-arm', ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'], 'GNU Arm GCC'],
      ] as const) {
        const key = `${family}\0${identity(directory)}`;
        if (checkedCompilers.has(key)) continue;
        checkedCompilers.add(key);
        if (
          !(await Promise.all(required.map((name) => regular(path.join(directory, name + suffix))))).every(
            Boolean,
          )
        )
          continue;
        const detected = await version(path.join(directory, required[0] + suffix));
        if (!detected) continue;
        const actual =
          candidate.version && family === 'gnu-arm' && candidate.version.startsWith(detected)
            ? candidate.version
            : detected;
        add({
          family,
          name: `${title} ${actual}`,
          version: actual,
          directory,
          source: candidate.source,
          platforms: ['stm32'],
        });
      }
    }
  }
  const configuredCli = options.config.toolchain.arduinoCli?.trim();
  const cliRoots = [
    ...(configuredCli && path.isAbsolute(configuredCli)
      ? [{ file: configuredCli, source: 'custom' as const }]
      : []),
    ...choices
      .filter((choice) => choice.arduinoCli && path.isAbsolute(choice.arduinoCli))
      .map((choice) => ({ file: choice.arduinoCli!, source: 'custom' as const })),
    { file: path.join(root, 'bin', 'arduino-cli' + suffix), source: 'managed' as const },
    ...cliVersions.map((entry) => ({
      file: path.join(entry.directory, 'bin', 'arduino-cli' + suffix),
      source: entry.source,
    })),
    ...paths.map((directory) => ({
      file: path.join(directory, 'arduino-cli' + suffix),
      source: 'path' as const,
    })),
  ];
  const cliTools = new Map<string, { file: string; version: string; source: Source }>();
  for (const candidate of cliRoots) {
    if (cliTools.has(identity(candidate.file))) continue;
    const detected = await version(candidate.file, true);
    if (detected) cliTools.set(identity(candidate.file), { ...candidate, version: detected });
  }
  const customStore = options.config.toolchain.packageDirectory?.trim();
  const stores = [
    ...(customStore && path.isAbsolute(customStore)
      ? [{ directory: path.resolve(customStore), source: 'custom' as const }]
      : []),
    ...choices
      .filter((choice) => choice.packageDirectory && path.isAbsolute(choice.packageDirectory))
      .map((choice) => ({ directory: path.resolve(choice.packageDirectory!), source: 'custom' as const })),
    { directory: root, source: 'managed' as const },
    ...coreVersions,
  ];
  const checkedStores = new Set<string>();
  for (const store of stores) {
    if (checkedStores.has(identity(store.directory))) continue;
    checkedStores.add(identity(store.directory));
    const hardware = path.join(store.directory, 'arduino-data', 'packages', 'esp32', 'hardware', 'esp32');
    const info = await fs.lstat(hardware).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const cores = (await fs.readdir(hardware, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry.name),
      )
      .slice(0, 64);
    for (const core of cores) {
      const directory = path.join(hardware, core.name);
      if (
        !(await regular(path.join(directory, 'platform.txt'))) ||
        !(await regular(path.join(directory, 'boards.txt')))
      )
        continue;
      for (const cli of cliTools.values()) {
        const source =
          store.source === 'custom' || cli.source === 'custom'
            ? 'custom'
            : store.source === 'versioned' || cli.source === 'versioned'
              ? 'versioned'
              : cli.source;
        add({
          family: 'arduino',
          name: `ESP32 ${core.name} · Arduino CLI ${cli.version}`,
          version: core.name,
          directory,
          arduinoCli: cli.file,
          packageDirectory: store.directory,
          source,
          platforms: ['esp32-s3'],
        });
      }
    }
  }
  return [...installed.values()].sort(
    (a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name, 'en', { numeric: true }),
  );
}
