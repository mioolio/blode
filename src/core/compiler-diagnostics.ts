import path from 'node:path';
import type { ProjectBuildInputs, ProjectFile } from '../shared/contracts';
import type { CompilerDiagnostic } from '../shared/compiler-diagnostics';

export interface CompilerContext {
  projectRoot: string;
  sourceRoot: string;
  files: readonly Pick<ProjectFile, 'path'>[];
  build: ProjectBuildInputs;
  namespace?: string;
}

export function parseCompilerDiagnostic(line: string) {
  const text = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  let file: string | undefined,
    row = 0,
    column = 1,
    severity: string,
    message: string;
  let match = /^(.*?):(\d+)(?::(\d+))?(?:-\d+)?:\s*(warning|fatal error|error):\s*(.+)$/i.exec(text);
  if (match) {
    [, file, , , severity, message] = match;
    row = Number(match[2]);
    column = Number(match[3] || 1);
  } else if (
    (match = /^(.+?)\((\d+)(?:\s*,\s*(\d+))?\)\s*:\s*(warning|fatal error|error)\b\s*:?[ \t]*(.*)$/i.exec(
      text,
    ))
  ) {
    [, file, , , severity, message] = match;
    row = Number(match[2]);
    column = Number(match[3] || 1);
  } else if ((match = /^"(.+?)",\s*line\s+(\d+):\s*(warning|fatal error|error)\s*:\s*(.+)$/i.exec(text))) {
    [, file, , severity, message] = match;
    row = Number(match[2]);
  } else if ((match = /^(?:[^:\r\n]+:\s*)?(warning|fatal error|error):\s*(.+)$/i.exec(text)))
    [, severity, message] = match;
  else if ((match = /^.+?\b(?:ld|armlink)(?:\.exe)?:.*?\b(warning|error):\s*(.+)$/i.exec(text)))
    [, severity, message] = match;
  else return undefined;
  if (row && (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || column < 1)) return undefined;
  return {
    file: file?.replace(/^["']|["']$/g, ''),
    line: row,
    column,
    severity: severity!.toLowerCase() === 'warning' ? ('warning' as const) : ('error' as const),
    message: message!.slice(0, 16000),
  };
}

/** Index exact source/staging aliases once per build; never guess by basename. */
export class CompilerOutput {
  private readonly aliases = new Map<string, string>();
  private readonly ambiguous = new Set<string>();
  private readonly windows: boolean;
  constructor(private readonly context: CompilerContext) {
    this.windows = /^[a-z]:/i.test(context.projectRoot) || process.platform === 'win32';
    const { sourceRoot, projectRoot, build } = context;
    const files = context.files.map((file) => file.path.replaceAll('\\', '/'));
    const entry = build.entry?.replaceAll('\\', '/');
    const entryFile = entry && files.includes(entry) ? entry : undefined;
    const directory = entryFile ? path.posix.dirname(entryFile) : entry && entry !== '.' ? entry : '';
    const entryDirectory = directory === '.' ? '' : directory;
    let selected = files.filter((file) => !entryDirectory || file.startsWith(`${entryDirectory}/`));
    if (build.files?.length) {
      const declared = new Set([
        ...build.files.map((file) => file.replaceAll('\\', '/')),
        ...(entryFile ? [entryFile] : []),
      ]);
      selected = selected.filter((file) => declared.has(file));
    }
    const main =
      entryFile ??
      (!entry ? build.sketch : undefined) ??
      selected.find(
        (file) => file.endsWith('.ino') && path.posix.dirname(file) === (entryDirectory || '.'),
      ) ??
      selected.find((file) => file.endsWith('.ino'));
    const selectedPaths = new Set(selected);
    const name = path.basename(sourceRoot).replace(/[^a-zA-Z0-9_]/g, '_') || 'sketch';
    const staging = path.join(sourceRoot, context.namespace ?? '.blode', 'staging', name);
    for (const file of files) {
      const absolute = path.resolve(sourceRoot, file);
      const relative = path.relative(projectRoot, absolute).replaceAll('\\', '/');
      if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
      this.add(file, relative);
      this.add(absolute, relative);
      this.add(path.relative(projectRoot, absolute), relative);
      if (selectedPaths.has(file))
        this.add(
          path.join(
            staging,
            file === main && file.endsWith('.ino')
              ? `${name}.ino`
              : entryDirectory
                ? path.posix.relative(entryDirectory, file)
                : file,
          ),
          relative,
        );
      if (build.components?.inputs.includes(file))
        this.add(path.join(staging, 'src', 'blode_components', file), relative);
    }
  }
  private key(value: string) {
    const normalized = path.normalize(value.replaceAll('\\', '/')).replaceAll('\\', '/').replace(/^\.\//, '');
    return this.windows ? normalized.toLowerCase() : normalized;
  }
  private add(alias: string, original: string) {
    const key = this.key(alias);
    if (this.ambiguous.has(key)) return;
    if (this.aliases.has(key) && this.aliases.get(key) !== original) {
      this.aliases.delete(key);
      this.ambiguous.add(key);
    } else this.aliases.set(key, original);
  }
  parse(line: string): CompilerDiagnostic | undefined {
    const parsed = parseCompilerDiagnostic(line);
    if (!parsed) return undefined;
    const file = parsed.file;
    const original = file
      ? (this.aliases.get(this.key(file)) ??
        this.aliases.get(this.key(path.resolve(this.context.sourceRoot, file))))
      : undefined;
    return {
      projectRoot: this.context.projectRoot,
      severity: parsed.severity,
      message: parsed.message,
      ...(file ? { file } : {}),
      ...(original && parsed.line > 0
        ? {
            location: {
              path: original,
              line: parsed.line,
              column: parsed.column,
              endLine: parsed.line,
              endColumn: parsed.column + 1,
            },
          }
        : {}),
    };
  }
}
