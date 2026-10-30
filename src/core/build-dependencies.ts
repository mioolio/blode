import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadBuildState } from './build-state';

/** Make escaping, including drive-letter colons, differs from shell escaping. */
export function parseDependencyFile(text: string): string[] {
  const joined = text.replace(/\\\r?\n/g, '');
  const colon = [...joined].findIndex(
    (char, index) =>
      char === ':' && index > 1 && joined[index - 1] !== '\\' && /\s/.test(joined[index + 1] ?? ''),
  );
  if (colon < 0) return [];
  const result: string[] = [];
  let word = '';
  for (let index = colon + 1; index < joined.length; index++) {
    const char = joined[index];
    if (char === '\n' || char === '\r') break;
    if (char === '\\' && /[ \t#:\\]/.test(joined[index + 1] ?? '')) {
      word += joined[++index];
      continue;
    }
    if (/\s/.test(char)) {
      if (word) result.push(word);
      word = '';
    } else word += char;
  }
  if (word) result.push(word);
  return result;
}
export interface BuildEvidenceRecord {
  root: string;
  buildDirectory: string;
  success: boolean;
  stale: boolean;
  timestamp?: string;
  toolchainRoots?: string[];
}
export interface BuildEvidenceStatus {
  success: boolean;
  stale: boolean;
  records?: BuildEvidenceRecord[];
}
export interface BuildDependencyEvidence {
  files: string[];
  includeDirectories: string[];
  complete: boolean;
  timestamp?: string;
  dependenciesByFile: Map<string, string[]>;
  warnings: { file: string; reference: string; reason: string }[];
}
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
};
const words = (text: string) =>
  (text.match(/(?:[^\s"]|"[^"]*")+/g) ?? []).map((value) => value.replace(/^"|"$/g, ''));

/** Read only fresh successful builds; each named target keeps independent evidence. */
export async function readBuildDependencies(
  root: string,
  status?: BuildEvidenceStatus,
): Promise<BuildDependencyEvidence> {
  const result: BuildDependencyEvidence = {
    files: [],
    includeDirectories: [],
    complete: false,
    dependenciesByFile: new Map(),
    warnings: [],
  };
  const files = new Set<string>(),
    includes = new Set<string>();
  const records = status?.records ?? [
    { root, buildDirectory: '.blode/build', success: status?.success ?? true, stale: status?.stale ?? false },
  ];
  let count = 0;
  for (const record of records) {
    const sourceRoot = await fs.realpath(record.root).catch(() => '');
    if (
      !sourceRoot ||
      !inside(root, sourceRoot) ||
      !/^\.blode\/(?:targets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/)?build$/.test(record.buildDirectory)
    )
      continue;
    if (!record.success || record.stale) {
      if (record.success && record.stale)
        result.warnings.push({
          file: path.relative(root, sourceRoot).replaceAll('\\', '/') || 'be',
          reference: record.buildDirectory,
          reason: 'build-evidence-stale',
        });
      continue;
    }
    const saved = await loadBuildState(
      sourceRoot,
      path.posix.join(path.posix.dirname(record.buildDirectory), 'build-state.json'),
    );
    if (!saved?.result.success) continue;
    const localFiles = new Set<string>(),
      localIncludes = new Set<string>(),
      groups = new Map<string, string[]>();
    let depfiles = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 16) return;
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (++count > 30000) throw new Error('error.packageTooLarge');
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(file, depth + 1);
          continue;
        }
        if (
          !entry.isFile() ||
          !(
            entry.name.endsWith('.d') ||
            entry.name === 'compile_commands.json' ||
            /\.(?:rsp|response|lnp)$/i.test(entry.name)
          )
        )
          continue;
        if ((await fs.stat(file)).size > 8_000_000) continue;
        const text = await fs.readFile(file, 'utf8');
        if (entry.name.endsWith('.d')) {
          depfiles++;
          const dependencies = parseDependencyFile(text).map((item) => path.resolve(sourceRoot, item));
          for (const dependency of dependencies) {
            localFiles.add(dependency);
            groups.set(dependency, [...new Set([...(groups.get(dependency) ?? []), ...dependencies])]);
          }
        } else if (entry.name === 'compile_commands.json')
          try {
            const commands = JSON.parse(text);
            if (!Array.isArray(commands)) continue;
            for (const command of commands.slice(0, 10000)) {
              const cwd = typeof command.directory === 'string' ? command.directory : sourceRoot;
              if (typeof command.file === 'string') localFiles.add(path.resolve(cwd, command.file));
              const args: string[] = Array.isArray(command.arguments)
                ? command.arguments
                : words(command.command ?? '');
              for (let index = 0; index < args.length; index++) {
                const include =
                  args[index] === '-I' || args[index] === '-isystem'
                    ? args[++index]
                    : args[index].startsWith('-I')
                      ? args[index].slice(2)
                      : undefined;
                if (include) localIncludes.add(path.resolve(cwd, include));
                else if (/\.(?:a|lib|ld|sct)$/i.test(args[index] ?? ''))
                  localFiles.add(path.resolve(cwd, args[index]));
              }
            }
          } catch {
            result.warnings.push({
              file: path.relative(root, file),
              reference: entry.name,
              reason: 'invalid-build-evidence',
            });
          }
        else
          for (const token of words(text))
            if (/\.(?:a|lib|ld|sct)$/i.test(token)) localFiles.add(path.resolve(sourceRoot, token));
      }
    };
    await visit(path.join(sourceRoot, record.buildDirectory), 0);
    let stale = false;
    for (const file of localFiles) {
      if (path.relative(sourceRoot, file).replaceAll('\\', '/').startsWith('.blode/')) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) result.warnings.push({ file: '', reference: file, reason: 'missing-build-dependency' });
      else if (stat.mtimeMs > Date.parse(saved.result.timestamp)) {
        stale = true;
        result.warnings.push({ file: '', reference: file, reason: 'build-evidence-stale' });
      }
    }
    if (stale) continue;
    for (const file of localFiles)
      if (!path.relative(sourceRoot, file).replaceAll('\\', '/').startsWith('.blode/')) files.add(file);
    for (const include of localIncludes) includes.add(include);
    for (const [file, dependencies] of groups)
      result.dependenciesByFile.set(process.platform === 'win32' ? file.toLowerCase() : file, [
        ...new Set([
          ...(result.dependenciesByFile.get(process.platform === 'win32' ? file.toLowerCase() : file) ?? []),
          ...dependencies,
        ]),
      ]);
    result.complete ||= depfiles > 0;
    result.timestamp =
      !result.timestamp || saved.result.timestamp > result.timestamp
        ? saved.result.timestamp
        : result.timestamp;
  }
  result.files = [...files];
  result.includeDirectories = [...includes];
  return result;
}
