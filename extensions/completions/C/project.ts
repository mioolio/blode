import type { CompletionEntry, CompletionKind } from '../types.js';

export interface CompletionFile {
  path: string;
  content: string;
}

const kinds = new Set<CompletionKind>([
  'function',
  'method',
  'type',
  'variable',
  'constant',
  'keyword',
  'snippet',
  'property',
]);

/** Normalize project-relative paths without importing Node's path module. */
function normalize(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function dirname(value: string): string {
  const normalized = normalize(value);
  return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
}

function resolveInclude(from: string, specifier: string): string {
  if (specifier.startsWith('/')) return normalize(specifier);
  if (specifier.startsWith('.')) return normalize(`${dirname(from)}/${specifier}`);
  return normalize(specifier);
}

function clip(value: string, length = 160): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function add(entries: Map<string, CompletionEntry>, entry: CompletionEntry): void {
  if (!entries.has(entry.name)) entries.set(entry.name, entry);
}

/** Extract macros, types and function signatures from one translation unit. */
function parseSource(file: CompletionFile, entries: Map<string, CompletionEntry>): void {
  const content = file.content.replace(/\/\*[\s\S]*?\*\//g, '');

  for (const match of content.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?\s*(.*)$/gm)) {
    const name = match[1]!;
    const parameters = match[2] ?? '';
    const replacement = match[3]!.trim();
    const functionLike = Boolean(parameters);
    add(entries, {
      name,
      kind: functionLike ? 'function' : 'constant',
      detail: clip(`#define ${name}${parameters}${replacement ? ` ${replacement}` : ''}`),
      documentation: `Defined in \`${file.path}\`.`,
      insertText: functionLike ? name + '(${1:})' : name,
      sortText: functionLike ? `1-${name}` : `4-${name}`,
    });
  }

  for (const match of content.matchAll(/^\s*typedef\s+[^;\n]+?\b([A-Za-z_]\w*)\s*;/gm)) {
    const name = match[1]!;
    add(entries, {
      name,
      kind: 'type',
      detail: clip(match[0].trim()),
      documentation: `Typedef in \`${file.path}\`.`,
      sortText: `2-${name}`,
    });
  }

  for (const match of content.matchAll(/^\s*(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm)) {
    const name = match[1]!;
    add(entries, {
      name,
      kind: 'type',
      detail: `struct ${name}`,
      documentation: `Type declared in \`${file.path}\`.`,
      sortText: `2-${name}`,
    });
  }

  for (const match of content.matchAll(
    /^\s*(?:static\s+|inline\s+|extern\s+|const\s+|volatile\s+|unsigned\s+|signed\s+|long\s+|short\s+)*(?:struct\s+\w+\s*|enum\s+\w+\s*|union\s+\w+\s*|[A-Za-z_]\w*(?:\s*\*)?)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*(?:;|\{)/gm,
  )) {
    const name = match[1]!;
    const parameters = match[2]!.trim();
    add(entries, {
      name,
      kind: 'function',
      detail: clip(`${name}(${parameters})`),
      documentation: `Function declared in \`${file.path}\`.`,
      insertText: name + '(${1:})',
      sortText: `1-${name}`,
    });
  }
}

/** Optional project-level completions: `blode.completions.json`. */
function parseCustom(files: readonly CompletionFile[], entries: Map<string, CompletionEntry>): void {
  const file = files.find((item) => normalize(item.path) === 'blode.completions.json');
  if (!file) return;
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch {
    return;
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? ((value as Record<string, unknown>).c ?? (value as Record<string, unknown>).cpp)
      : null;
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || !/^[A-Za-z_]\w*$/.test(record.name)) continue;
    const kind =
      typeof record.kind === 'string' && kinds.has(record.kind as CompletionKind)
        ? (record.kind as CompletionKind)
        : 'snippet';
    const detail =
      typeof record.detail === 'string' && record.detail.trim()
        ? clip(record.detail)
        : `Custom completion: ${record.name}`;
    entries.set(record.name, {
      name: record.name,
      kind,
      detail,
      documentation: typeof record.documentation === 'string' ? clip(record.documentation, 400) : undefined,
      insertText:
        typeof record.insertText === 'string' && record.insertText ? record.insertText : record.name,
      sortText: `0-${record.name}`,
    });
  }
}

/**
 * Resolve the active file and its quoted includes recursively. This is a
 * lightweight symbol index, not a C compiler: it is deterministic, runs locally
 * and never executes project code. Unresolved includes fall back to a basename
 * match so user headers in another directory are still discoverable.
 */
export function parseCustomCCompletions(files: readonly CompletionFile[]): CompletionEntry[] {
  const entries = new Map<string, CompletionEntry>();
  parseCustom(files, entries);
  return [...entries.values()];
}

export function parseCProjectCompletions(
  files: readonly CompletionFile[],
  activePath: string,
): CompletionEntry[] {
  const entries = new Map<string, CompletionEntry>();
  parseCustom(files, entries);
  const byPath = new Map(files.map((file) => [normalize(file.path), file]));
  const active =
    byPath.get(normalize(activePath)) ??
    files.find((file) => normalize(file.path).endsWith(`/${normalize(activePath)}`)) ??
    byPath.get(`/${normalize(activePath)}`);
  if (!active) return [...entries.values()];

  const visited = new Set<string>();
  const visit = (file: CompletionFile, depth: number) => {
    const key = normalize(file.path);
    if (depth > 16 || visited.has(key) || visited.size > 256) return;
    visited.add(key);
    parseSource(file, entries);
    for (const match of file.content.matchAll(/^\s*#\s*include\s+["<]([^">]+)[">]/gm)) {
      const requested = match[1]!;
      const resolved = resolveInclude(file.path, requested);
      const next =
        byPath.get(resolved) ??
        files.find((candidate) => normalize(candidate.path).endsWith(`/${normalize(requested)}`));
      if (next) visit(next, depth + 1);
    }
  };

  visit(active, 0);
  return [...entries.values()];
}
