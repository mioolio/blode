import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppState, ProjectConfig } from '../../shared/contracts';
import type { BuildEvidenceStatus } from '../build-dependencies';
import { getCompilerIncludeRoots } from '../compiler-includes';
import { parseProjectBuild } from '../config';
import { C_STANDARDS, type CStandard } from '../../../extensions/completions/rules';
import { prepareExternalCompilationDatabase } from './compile-database';
import { stm32ClangdPlatform } from '../../../extensions/boards/STM32F103C8T6/compiler/clangd';

const sourceFile = /\.(?:c|cc|cpp|cxx|ino)$/i;
const headerFile = /\.(?:h|hh|hpp|hxx)$/i;

export interface ClangdProjectOptions {
  root: string;
  files: readonly { path: string; content: string }[];
  config: ProjectConfig;
  toolchainRoot: string;
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
  buildEvidence?: BuildEvidenceStatus;
  signal?: AbortSignal;
}

function standardFromFiles(files: readonly { path: string; content: string }[]): CStandard {
  const marker = files.find((file) => file.path === 'be');
  if (!marker) return 'c17';
  try {
    const standard = parseProjectBuild(JSON.parse(marker.content).build).cStandard;
    return C_STANDARDS.includes(standard as CStandard) ? (standard as CStandard) : 'c17';
  } catch {
    return 'c17';
  }
}

/**
 * Build a private compilation database so clangd understands project include
 * folders without writing into the user's project. Background index data also
 * stays beside this file rather than in the workspace.
 */
export async function prepareClangdProject(
  options: ClangdProjectOptions,
): Promise<{ directory: string; fallbackFlags: string[] }> {
  const standard = standardFromFiles(options.files);
  const external = await prepareExternalCompilationDatabase(options);
  if (external) return external;
  const includeRoots = await getCompilerIncludeRoots(
    {
      workspace: { projectRoot: options.root, files: options.files as AppState['files'] },
      config: options.config,
      toolchainRoot: options.toolchainRoot,
      env: options.env,
      buildEvidence: options.buildEvidence,
      signal: options.signal,
    },
    true,
  ).catch(() => [options.root]);
  // Do not depend on a .uvprojx: many exported projects omit it. Derive include
  // roots recursively from the workspace inventory instead, prioritizing the
  // directories of headers and the `be` build entry.
  const platform =
    options.config.boardId === 'STM32F103C8T6'
      ? stm32ClangdPlatform(options.files, options.config)
      : { flags: [] as string[], includes: [] as string[] };
  const discovered = new Set<string>();
  const boundary = path.resolve(options.root) + path.sep;
  const addDirectory = (file: string) => {
    const absolute = path.resolve(options.root, file);
    if (absolute.startsWith(boundary)) discovered.add(path.dirname(absolute));
  };
  try {
    const descriptor = JSON.parse(options.files.find((file) => file.path === 'be')?.content ?? '{}');
    for (const entry of [descriptor.build?.entry, descriptor.build?.sketch])
      if (typeof entry === 'string' && entry) addDirectory(entry);
    for (const entry of descriptor.build?.files ?? [])
      if (typeof entry === 'string' && entry) addDirectory(entry);
  } catch {
    /* An edited or missing descriptor falls back to the workspace scan. */
  }
  for (const file of options.files)
    if (headerFile.test(file.path) || sourceFile.test(file.path)) addDirectory(file.path);
  const includes = [
    ...new Set(
      [...includeRoots, ...discovered, ...platform.includes].filter((directory) =>
        path.isAbsolute(directory),
      ),
    ),
  ].slice(0, 192);
  const compileFlags = platform.flags;
  const key = createHash('sha256')
    .update(options.root)
    .update('\0')
    .update(JSON.stringify(options.config))
    .update('\0')
    .update(standard)
    .digest('hex')
    .slice(0, 16);
  const directory = path.join(options.dataRoot, 'clangd', key);
  await fs.mkdir(directory, { recursive: true });
  const commands = options.files
    .filter((file) => sourceFile.test(file.path))
    .slice(0, 4000)
    .map((file) => {
      const absolute = path.resolve(options.root, file.path);
      const cpp = /\.(?:cc|cpp|cxx|ino)$/i.test(file.path);
      return {
        directory: options.root,
        file: absolute,
        arguments: [
          'clang',
          ...compileFlags,
          '-x',
          cpp ? 'c++' : 'c',
          `-std=${cpp ? 'c++17' : standard}`,
          ...includes.flatMap((include) => ['-I', include]),
          absolute,
        ],
      };
    });
  await fs.writeFile(path.join(directory, 'compile_commands.json'), JSON.stringify(commands));
  const fallbackFlags = [
    ...compileFlags,
    `-std=${standard}`,
    ...includes.flatMap((include) => ['-I', include]),
  ];
  return { directory, fallbackFlags };
}

export function isClangdSource(pathValue: string): boolean {
  return sourceFile.test(pathValue) || headerFile.test(pathValue);
}
