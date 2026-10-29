import { cRulePacks } from './C/index';
import type { CompletionEntry, CompletionKind, LanguageCompletions } from './types';

export const C_STANDARDS = ['c99', 'c11', 'c17', 'c23'] as const;
export type CStandard = (typeof C_STANDARDS)[number];
export interface LanguageRuleFile {
  path: string;
  content: string;
}
export interface LanguageRuleDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning';
  message: string;
  rule?: string;
}
export interface SourceRule {
  id: string;
  kind: 'call' | 'token';
  names: string[];
  severity: 'error' | 'warning';
  message: string;
  enabled: boolean;
}
export interface CCompletionPack {
  contribution: LanguageCompletions;
  diagnostics: LanguageRuleDiagnostic[];
  rules: SourceRule[];
}
const kinds = new Set<CompletionKind>([
  'function',
  'method',
  'variable',
  'constant',
  'type',
  'keyword',
  'snippet',
  'property',
]);
const normalize = (value: string) => value.replaceAll('\\', '/');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 8192): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const identifiers = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 128 &&
  value.every((name) => typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name));

function position(content: string, offset: number) {
  const before = content.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  return { line, column: before.length - before.lastIndexOf('\n') };
}

/** Parse the selected standard only. Project JSON overrides a matching builtin entry. */
export function resolveCCompletionPack(
  files: readonly LanguageRuleFile[],
  standard: CStandard = 'c17',
  options: { useBuiltins?: boolean; useBuiltinRules?: boolean } = {},
): CCompletionPack {
  const diagnostics: LanguageRuleDiagnostic[] = [];
  const snippets = new Map<string, CompletionEntry>();
  const symbols = new Map<string, CompletionEntry>();
  const rules = new Map<string, SourceRule>();
  const issue = (
    file: string,
    content: string,
    message: string,
    key = '',
    severity: 'error' | 'warning' = 'error',
  ) => {
    const offset = key ? content.indexOf(JSON.stringify(key)) : 0;
    diagnostics.push({ file, ...position(content, offset), severity, message });
  };
  if (!C_STANDARDS.includes(standard)) {
    diagnostics.push({
      file: 'be',
      line: 1,
      column: 1,
      severity: 'error',
      message: `不支持的 C 标准：${String(standard)}`,
    });
    return { contribution: { language: 'cpp', snippets: [], symbols: [] }, diagnostics, rules: [] };
  }
  const load = (assets: readonly { path: string; value?: unknown; content?: string }[]) => {
    const seen = new Set<string>();
    for (const asset of assets) {
      const content = asset.content ?? JSON.stringify(asset.value, null, 2);
      let value: unknown = asset.value;
      if (asset.content !== undefined) {
        try {
          value = JSON.parse(asset.content);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const offset = Number(/position\s+(\d+)/i.exec(message)?.[1] ?? 0);
          diagnostics.push({
            file: asset.path,
            ...position(content, offset),
            severity: 'error',
            message: `JSON 解析失败：${message}`,
          });
          continue;
        }
      }
      if (!object(value)) {
        issue(asset.path, content, '规则文件必须是 JSON 对象。');
        continue;
      }
      const topKeys = ['schemaVersion', 'language', 'standard', 'symbols', 'snippets', 'rules', 'files'];
      for (const key of Object.keys(value))
        if (!topKeys.includes(key)) issue(asset.path, content, `未知规则字段：${key}`, key);
      if (value.schemaVersion !== 1) {
        issue(asset.path, content, 'schemaVersion 必须为 1。', 'schemaVersion');
        continue;
      }
      if (value.language !== 'c') {
        issue(asset.path, content, 'C 规则文件的 language 必须为 c。', 'language');
        continue;
      }
      if (value.standard !== standard) {
        issue(
          asset.path,
          content,
          `目录使用 ${standard}，文件声明为 ${String(value.standard)}。`,
          'standard',
        );
        continue;
      }
      if (value.files !== undefined) {
        if (
          !Array.isArray(value.files) ||
          value.files.length > 128 ||
          !value.files.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]*\.json$/.test(name))
        )
          issue(asset.path, content, 'files 必须是当前目录的 JSON 文件名数组。', 'files');
        else
          for (const name of value.files)
            if (
              !assets.some(
                (candidate) => candidate.path === asset.path.slice(0, asset.path.lastIndexOf('/') + 1) + name,
              )
            )
              issue(asset.path, content, `manifest 引用了缺失文件：${name}`, 'files');
      }
      for (const group of ['symbols', 'snippets'] as const) {
        if (value[group] === undefined) continue;
        if (!Array.isArray(value[group]) || value[group].length > 2048) {
          issue(asset.path, content, `${group} 必须是补全条目数组。`, group);
          continue;
        }
        for (const item of value[group]) {
          if (
            !object(item) ||
            !text(item.name, 128) ||
            !text(item.detail, 512) ||
            !kinds.has(item.kind as CompletionKind)
          ) {
            issue(asset.path, content, '补全条目需要 name、kind 和 detail。', group);
            continue;
          }
          const entryKeys = ['name', 'kind', 'detail', 'documentation', 'insertText', 'sortText'];
          let valid = true;
          for (const key of Object.keys(item)) {
            if (!entryKeys.includes(key)) {
              issue(asset.path, content, `补全 ${item.name} 包含未知字段：${key}`, key);
              valid = false;
            }
          }
          for (const key of ['documentation', 'insertText', 'sortText'])
            if (item[key] !== undefined && !text(item[key])) {
              issue(asset.path, content, `补全 ${item.name} 的 ${key} 必须是非空字符串。`, key);
              valid = false;
            }
          if (!valid) continue;
          const key = `${group}:${item.name}`;
          if (seen.has(key)) {
            issue(asset.path, content, `重复补全：${item.name}`, item.name);
            continue;
          }
          seen.add(key);
          (group === 'snippets' ? snippets : symbols).set(item.name, {
            ...item,
          } as unknown as CompletionEntry);
        }
      }
      if (value.rules !== undefined) {
        if (!Array.isArray(value.rules) || value.rules.length > 128) {
          issue(asset.path, content, 'rules 必须是规则数组。', 'rules');
          continue;
        }
        for (const item of value.rules) {
          if (
            !object(item) ||
            !text(item.id, 80) ||
            !/^[a-z][a-z0-9-]*$/.test(item.id) ||
            !['call', 'token'].includes(String(item.kind)) ||
            !identifiers(item.names) ||
            !['error', 'warning'].includes(String(item.severity)) ||
            !text(item.message, 1024) ||
            (item.enabled !== undefined && typeof item.enabled !== 'boolean')
          ) {
            issue(
              asset.path,
              content,
              '语义规则需要 id、kind(call/token)、names、severity(error/warning) 和 message。',
              'rules',
            );
            continue;
          }
          if (
            Object.keys(item).some(
              (key) => !['id', 'kind', 'names', 'severity', 'message', 'enabled'].includes(key),
            )
          ) {
            issue(asset.path, content, `语义规则 ${item.id} 含未知字段。`, 'rules');
            continue;
          }
          const key = `rule:${item.id}`;
          if (seen.has(key)) {
            issue(asset.path, content, `重复规则：${item.id}`, item.id);
            continue;
          }
          seen.add(key);
          rules.set(item.id, { ...item, enabled: item.enabled !== false } as unknown as SourceRule);
        }
      }
    }
  };
  if (options.useBuiltins !== false || options.useBuiltinRules !== false) load(cRulePacks[standard]);
  if (options.useBuiltins === false) {
    snippets.clear();
    symbols.clear();
  }
  if (options.useBuiltinRules === false) rules.clear();
  const prefix = `languages/C/${standard}/`;
  const custom = files.filter(
    (file) =>
      normalize(file.path).startsWith(prefix) &&
      /^[^/]+\.json$/.test(normalize(file.path).slice(prefix.length)),
  );
  if (custom.length > 128) issue(prefix + 'manifest.json', '', '同一标准最多支持 128 个规则文件。');
  load(custom.slice(0, 128).map((file) => ({ path: normalize(file.path), content: file.content })));
  const legacy = files.find((file) => normalize(file.path) === 'blode.completions.json');
  if (legacy) {
    try {
      const value: unknown = JSON.parse(legacy.content);
      const list = Array.isArray(value) ? value : object(value) ? (value.c ?? value.cpp) : undefined;
      if (!Array.isArray(list))
        issue(legacy.path, legacy.content, '补全清单需要数组，或包含 c / cpp 数组的对象。');
      else {
        const names = new Set<string>();
        for (const item of list) {
          if (!object(item) || !text(item.name, 128) || !/^[A-Za-z_]\w*$/.test(item.name)) {
            issue(legacy.path, legacy.content, '补全条目需要有效的 name 标识符。');
            continue;
          }
          if (names.has(item.name))
            issue(legacy.path, legacy.content, `重复补全：${item.name}`, item.name, 'warning');
          names.add(item.name);
          if (item.kind !== undefined && !kinds.has(item.kind as CompletionKind))
            issue(legacy.path, legacy.content, `未知补全 kind：${String(item.kind)}`, 'kind', 'warning');
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const offset = Number(/position\s+(\d+)/i.exec(message)?.[1] ?? 0);
      diagnostics.push({
        file: legacy.path,
        ...position(legacy.content, offset),
        severity: 'error',
        message: `JSON 解析失败：${message}`,
      });
    }
  }
  return {
    contribution: {
      language: 'cpp',
      triggerCharacters: ['#', '.'],
      snippets: [...snippets.values()],
      symbols: [...symbols.values()],
    },
    diagnostics,
    rules: [...rules.values()],
  };
}

export function validateProjectLanguageRules(
  files: readonly LanguageRuleFile[],
  standard: CStandard = 'c17',
): LanguageRuleDiagnostic[] {
  return resolveCCompletionPack(files, standard).diagnostics;
}

/** Declarative token/call checks; comments and literal contents retain positions but are masked. */
export function analyzeCSourceRules(
  files: readonly LanguageRuleFile[],
  standard: CStandard = 'c17',
  options: { pack?: CCompletionPack; mixedCpp?: boolean } = {},
): LanguageRuleDiagnostic[] {
  const pack = options.pack ?? resolveCCompletionPack(files, standard);
  if (pack.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return [];
  const rulesByName = new Map<string, SourceRule[]>();
  for (const rule of pack.rules) {
    if (!rule.enabled) continue;
    for (const name of rule.names) rulesByName.set(name, [...(rulesByName.get(name) ?? []), rule]);
  }
  const diagnostics: LanguageRuleDiagnostic[] = [];
  const mixedCpp = options.mixedCpp ?? files.some((file) => /\.(?:cpp|cxx|cc|ino|hpp|hxx)$/i.test(file.path));
  for (const file of files) {
    // A .h file may belong to C++; leave ambiguous mixed-project headers to
    // the compiler rather than applying the C dialect to C++ declarations.
    if (!/\.c$/i.test(file.path) && (!/\.h$/i.test(file.path) || mixedCpp)) continue;
    const masked = file.content.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
      (value) => value.replace(/[^\n]/g, ' '),
    );
    for (const match of masked.matchAll(/\b[A-Za-z_]\w*\b/g)) {
      for (const rule of rulesByName.get(match[0]) ?? []) {
        if (
          !rule.names.includes(match[0]) ||
          (rule.kind === 'call' && !/^\s*\(/.test(masked.slice(match.index! + match[0].length)))
        )
          continue;
        const start = position(file.content, match.index!);
        diagnostics.push({
          file: file.path,
          ...start,
          endLine: start.line,
          endColumn: start.column + match[0].length,
          severity: rule.severity,
          message: rule.message,
          rule: rule.id,
        });
        if (diagnostics.length >= 500) return diagnostics;
      }
    }
  }
  return diagnostics;
}
