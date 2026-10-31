import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setImmediate as yieldControl } from 'node:timers/promises';
import type { AppState, ProjectConfig } from '../shared/contracts';
import type { BuildSettings, CompilerChoice } from '../shared/build-settings';
import { readBuildDependencies, type BuildEvidenceStatus } from './build-dependencies';
import { safeWorkspacePath } from './workspace';
import { boundedNavigationMap } from './language-navigation-work';

type Workspace = Pick<AppState, 'projectRoot' | 'files'>;
const text = async (file: string, limit = 4_000_000): Promise<string> => {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() && stat.size <= limit ? fs.readFile(file, 'utf8') : '';
};
const directories = async (directory: string): Promise<string[]> =>
  (await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((item) => item.isDirectory() && !item.isSymbolicLink() && !item.name.startsWith('.'))
    .map((item) => path.join(directory, item.name));

/** Split compiler metadata only. Nothing in a command or response file is executed. */
export function compilerArguments(command: string): string[] {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) =>
    token.replace(/"([^"]*)"|'([^']*)'/g, (_match, double, single) => double ?? single),
  );
}
export function compilerIncludeArguments(args: readonly string[], cwd: string): string[] {
  const result: string[] = [];
  let prefix = cwd;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '-iprefix' && args[i + 1]) {
      prefix = path.resolve(cwd, args[++i]);
      continue;
    }
    let value: string | undefined;
    if (['-I', '-isystem', '-iquote', '-idirafter', '/I', '--include_path'].includes(argument))
      value = args[++i];
    else if (argument === '-iwithprefixbefore' || argument === '-iwithprefix') {
      if (args[i + 1]) result.push(path.resolve(prefix, args[++i]));
      continue;
    } else if (/^-I.+/.test(argument)) value = argument.slice(2);
    else if (/^-(?:isystem|iquote|idirafter)=?./.test(argument))
      value = argument.replace(/^-(?:isystem|iquote|idirafter)=?/, '');
    else if (/^\/I.+/.test(argument)) value = argument.slice(2);
    else if (argument.startsWith('--include_path=')) value = argument.slice('--include_path='.length);
    if (value && !/[\0\r\n$]/.test(value)) result.push(path.resolve(cwd, value));
  }
  return result;
}

/** Actual project metadata, selected compilers and installed SDK include lists. */
export async function getCompilerIncludeRoots(
  options: {
    workspace: Workspace;
    config: ProjectConfig;
    toolchainRoot: string;
    env?: NodeJS.ProcessEnv;
    buildEvidence?: BuildEvidenceStatus;
    signal?: AbortSignal;
  },
  discoverTargets = true,
): Promise<string[]> {
  const check = () => {
    if (options.signal?.aborted) throw new Error('error.operationCancelled');
  };
  check();
  const { workspace, config } = options,
    root = workspace.projectRoot;
  const env = options.env ?? process.env,
    includes = new Set<string>([root]);
  const add = (directory: string) => {
    if (directory && !/[\0\r\n$]/.test(directory)) includes.add(path.resolve(root, directory));
  };
  let descriptor: Record<string, any> = {};
  try {
    descriptor = JSON.parse(workspace.files.find((file) => file.path === 'be')?.content ?? '{}');
  } catch {
    /* Editing the descriptor does not disable navigation. */
  }
  const targetContexts: { root: string; id: string; config: ProjectConfig; files: AppState['files'] }[] = [];
  if (discoverTargets && Array.isArray(descriptor.build?.targets)) {
    for (const target of descriptor.build.targets.slice(0, 64)) {
      check();
      if (
        !target ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.id ?? '') ||
        typeof target.root !== 'string'
      )
        continue;
      try {
        const sourceRoot = target.root === '.' ? root : await safeWorkspacePath(root, target.root);
        const prefix = target.root === '.' ? '' : target.root.replaceAll('\\', '/') + '/';
        const files = workspace.files
          .filter((file) => !prefix || file.path.startsWith(prefix))
          .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
        const childText =
          files.find((file) => file.path === 'be')?.content ??
          (await text(await safeWorkspacePath(sourceRoot, 'be')));
        let child: Record<string, any> = {};
        try {
          child = childText.trim() ? JSON.parse(childText) : {};
        } catch {}
        const selected = {
          ...config,
          ...child,
          ...target.config,
          toolchain: { ...config.toolchain, ...child.toolchain, ...target.config?.toolchain },
        } as ProjectConfig;
        delete (selected as ProjectConfig & { build?: unknown }).build;
        const mergedSettings: BuildSettings = {};
        for (const settings of [
          descriptor.build?.settings,
          child.build?.settings,
          target.build?.settings,
        ].filter(Boolean)) {
          const platforms = { ...mergedSettings.platforms };
          for (const [id, value] of Object.entries(settings.platforms ?? {}))
            platforms[id] = { ...platforms[id], ...(value as object) };
          Object.assign(mergedSettings, settings, { platforms });
        }
        const be = {
          path: 'be',
          language: 'json',
          content: JSON.stringify({ ...selected, build: { settings: mergedSettings } }),
        };
        targetContexts.push({
          root: sourceRoot,
          id: target.id,
          config: selected,
          files: [be, ...files.filter((file) => file.path !== 'be')],
        });
      } catch {
        /* Invalid target paths do not disable navigation in other projects. */
      }
    }
  }
  const settings = descriptor.build?.settings;
  const platform = settings?.platforms?.[config.boardId];
  const choices: CompilerChoice[] = [settings?.common, platform?.common, platform?.c, platform?.cpp].filter(
    Boolean,
  );
  try {
    const manifest = JSON.parse((await text(path.join(root, 'blode.components.json'))) || '{}');
    for (const component of manifest.components ?? []) {
      for (const include of component.includes ?? []) if (typeof include === 'string') add(include);
      if (component.kind === 'arduino' && typeof component.path === 'string') {
        add(component.path);
        add(path.join(component.path, 'src'));
      }
    }
  } catch {
    /* Invalid component metadata is reported by the component manager. */
  }
  const records = options.buildEvidence?.records ?? [
    { root, buildDirectory: '.blode/build', success: true, stale: false },
    ...targetContexts.map((target) => ({
      root: target.root,
      buildDirectory: `.blode/targets/${target.id}/build`,
      success: true,
      stale: false,
    })),
  ];
  const evidence = await readBuildDependencies(root, {
    ...options.buildEvidence,
    success: options.buildEvidence?.success ?? true,
    stale: options.buildEvidence?.stale ?? false,
    records,
  }).catch(() => undefined);
  check();
  for (const directory of evidence?.includeDirectories ?? []) add(directory);
  for (const file of evidence?.files ?? []) if (/\.(?:h|hpp|hh|hxx)$/i.test(file)) add(path.dirname(file));

  // compile_commands may be generated before a successful build, including by external IDEs.
  const metadata = new Set([
    path.join(root, 'compile_commands.json'),
    path.join(root, 'build', 'compile_commands.json'),
  ]);
  let visited = 0;
  const scanMetadata = async (directory: string, depth = 0) => {
    check();
    if (depth > 10 || visited > 16000) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      check();
      if (++visited > 16000) return;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scanMetadata(file, depth + 1);
      else if (
        entry.isFile() &&
        (entry.name === 'compile_commands.json' || /\.(?:rsp|response)$/i.test(entry.name))
      )
        metadata.add(file);
    }
  };
  await scanMetadata(path.join(root, '.blode', 'build'));
  await scanMetadata(path.join(root, '.blode', 'targets'));
  for (const record of records) {
    const relative = path.relative(root, record.root).replaceAll('\\', '/');
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !/^\.blode\/(?:targets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/)?build$/.test(record.buildDirectory)
    )
      continue;
    try {
      const directory = await safeWorkspacePath(
        root,
        [relative, record.buildDirectory].filter(Boolean).join('/'),
        { internal: true },
      );
      await scanMetadata(directory);
    } catch {}
  }
  for (const file of metadata) {
    check();
    const content = await text(file);
    if (file.endsWith('.json')) {
      try {
        const commands = JSON.parse(content);
        if (!Array.isArray(commands)) continue;
        for (const command of commands.slice(0, 10000)) {
          check();
          const cwd = typeof command.directory === 'string' ? path.resolve(root, command.directory) : root;
          const args =
            Array.isArray(command.arguments) &&
            command.arguments.every((arg: unknown) => typeof arg === 'string')
              ? command.arguments
              : compilerArguments(typeof command.command === 'string' ? command.command : '');
          compilerIncludeArguments(args, cwd).forEach(add);
          await yieldControl();
        }
      } catch {
        /* Missing or partial compiler exports are ordinary while a build is running. */
      }
    } else compilerIncludeArguments(compilerArguments(content), root).forEach(add);
  }
  // Compiler standard headers are available even before the first project build.
  for (const directory of [
    config.toolchain.armCompilerDirectory,
    ...choices.map((choice) => choice.directory),
  ].filter((value): value is string => !!value)) {
    check();
    add(path.join(directory, 'include'));
    add(path.join(directory, '..', 'include'));
    for (const base of [directory, path.dirname(directory)]) {
      for (const compiler of await directories(path.join(base, 'lib', 'gcc', 'arm-none-eabi')))
        add(path.join(compiler, 'include'));
      add(path.join(base, 'arm-none-eabi', 'include'));
    }
  }
  const arduino =
    /esp32/i.test(config.boardId + config.toolchain.fqbn) ||
    choices.some((choice) => choice.family === 'arduino') ||
    workspace.files.some(
      (file) =>
        /\.ino$/i.test(file.path) &&
        !targetContexts.some((target) => {
          const relative = path.relative(root, target.root).replaceAll('\\', '/');
          return relative && file.path.startsWith(relative + '/');
        }),
    );
  if (arduino) {
    const stores = new Set(
      [
        options.toolchainRoot,
        config.toolchain.packageDirectory,
        ...choices.map((choice) => choice.packageDirectory),
      ].filter((value): value is string => !!value),
    );
    for (const version of await directories(path.join(options.toolchainRoot, 'versions', 'arduino-esp32')))
      stores.add(version);
    const dataDirectories = new Set([
      ...[...stores].map((store) => path.join(store, 'arduino-data')),
      ...(env.ARDUINO_DIRECTORIES_DATA ? [env.ARDUINO_DIRECTORIES_DATA] : []),
      ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Arduino15')] : []),
      path.join(os.homedir(), '.arduino15'),
    ]);
    const configuredVersion = [...choices]
      .reverse()
      .find((choice) => choice.family === 'arduino' && choice.version)?.version;
    for (const data of dataDirectories) {
      check();
      const packageRoot = path.join(data, 'packages', 'esp32');
      const versions = (await directories(path.join(packageRoot, 'hardware', 'esp32'))).sort((a, b) =>
        b.localeCompare(a, 'en', { numeric: true }),
      );
      const core = configuredVersion
        ? versions.find((version) => path.basename(version) === configuredVersion)
        : versions[0];
      if (!core || !(await text(path.join(core, 'platform.txt')))) continue;
      add(path.join(core, 'cores', 'esp32'));
      let chip = /esp32(?:s[23]|c[236]|h2)?/i
        .exec(config.toolchain.fqbn.split(':')[2] ?? '')?.[0]
        ?.toLowerCase();
      const board = config.toolchain.fqbn.split(':')[2];
      if (board) {
        const match = (await text(path.join(core, 'boards.txt')))
          .split(/\r?\n/)
          .find((line) => line.startsWith(`${board}.build.mcu=`));
        if (match) chip = match.split('=')[1].trim();
        add(path.join(core, 'variants', board));
      }
      chip ??= /s3/i.test(config.boardId) ? 'esp32s3' : 'esp32';
      // The installed package index maps each core release to its exact SDK tool version.
      let sdkVersion: string | undefined;
      try {
        const index = JSON.parse(await text(path.join(data, 'package_esp32_index.json'), 12_000_000));
        sdkVersion = index.packages
          ?.find((item: any) => item.name === 'esp32')
          ?.platforms?.find((item: any) => item.version === path.basename(core))
          ?.toolsDependencies?.find((item: any) => item.name === 'esp32-arduino-libs')?.version;
      } catch {
        /* Older package installs can lack their downloaded index. */
      }
      const sdks = (await directories(path.join(packageRoot, 'tools', 'esp32-arduino-libs'))).filter(
        (directory) => !sdkVersion || path.basename(directory) === sdkVersion,
      );
      for (const sdk of sdks) {
        check();
        const target = path.join(sdk, chip),
          prefix = path.join(target, 'include');
        const flags = await text(path.join(target, 'flags', 'includes'));
        compilerIncludeArguments(['-iprefix', prefix, ...compilerArguments(flags)], target).forEach(add);
        add(prefix);
      }
      // Arduino 2.x stores the SDK and its include directories inside the core.
      const oldSdk = path.join(core, 'tools', 'sdk', chip, 'include');
      for (const component of await directories(oldSdk)) add(component);
      for (const library of await directories(path.join(core, 'libraries'))) {
        add(library);
        add(path.join(library, 'src'));
      }
    }
    for (const store of stores)
      for (const library of await directories(path.join(store, 'libraries'))) {
        add(library);
        add(path.join(library, 'src'));
      }
  }
  for (const target of targetContexts) {
    check();
    const directories = await getCompilerIncludeRoots(
      {
        ...options,
        workspace: { projectRoot: target.root, files: target.files },
        config: target.config,
        buildEvidence: {
          success: true,
          stale: false,
          records: records.filter((record) => path.resolve(record.root) === path.resolve(target.root)),
        },
      },
      false,
    );
    directories.forEach(add);
  }
  const result = await boundedNavigationMap([...includes].slice(0, 1024), async (directory) => {
    check();
    const stat = await fs.lstat(directory).catch(() => null);
    return stat?.isDirectory() && !stat.isSymbolicLink() ? fs.realpath(directory) : undefined;
  });
  check();
  return [...new Set(result.filter((value): value is string => !!value))];
}
