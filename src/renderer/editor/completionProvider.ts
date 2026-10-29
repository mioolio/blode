import type * as Monaco from 'monaco-editor';
import { WorkspaceLanguageIndex, normalizeSourcePath } from '../../shared/language-index';
import type { SourceLocation } from '../../shared/language';
import type { CStandard } from '../../../extensions/completions/rules';
import { LanguageRuleCache } from './languageRuleCache';
import { resolveCCompletionCatalog } from '../../shared/c-completion-catalog';
import { listLanguageCompletions } from '../../../extensions/completions';
import { parseCustomCCompletions, type CompletionFile } from '../../../extensions/completions/c';
import { resolveCompletionCatalog } from '../../shared/completion-catalog';
import type { AiAssistanceState } from '../../shared/ai';
import {
  analyzeModuleLanguageRules,
  moduleLanguageForFile,
  type ModuleLanguageState,
} from '../../shared/module-languages';
import { ModuleLanguageCache } from './moduleLanguageCache';
import type {
  CompletionEntry,
  CompletionKind,
  LanguageCompletions,
} from '../../../extensions/completions/types';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

const sortOrder: Record<CompletionKind, string> = {
  snippet: '0',
  function: '1',
  method: '1',
  type: '2',
  variable: '3',
  constant: '4',
  property: '5',
  keyword: '6',
};

const hasSnippetSyntax = (value: string) => /\$\{\d+(?::[^}]*)?\}/.test(value);

function completionKind(monaco: MonacoApi, kind: CompletionKind): Monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'function':
      return kinds.Function;
    case 'method':
      return kinds.Method;
    case 'variable':
      return kinds.Variable;
    case 'constant':
      return kinds.Constant;
    case 'type':
      return kinds.Class;
    case 'keyword':
      return kinds.Keyword;
    case 'snippet':
      return kinds.Snippet;
    case 'property':
      return kinds.Property;
  }
}

function toSuggestion(
  monaco: MonacoApi,
  entry: CompletionEntry,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const insertText = entry.insertText ?? entry.name;
  return {
    label: entry.name,
    kind: completionKind(monaco, entry.kind),
    detail: entry.detail,
    documentation: entry.documentation ? { value: entry.documentation } : undefined,
    insertText,
    insertTextRules: hasSnippetSyntax(insertText)
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    sortText: entry.sortText ?? `${sortOrder[entry.kind]}-${entry.name}`,
    range,
  };
}

function createProvider(
  monaco: MonacoApi,
  contribution: LanguageCompletions,
): Monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: contribution.triggerCharacters,
    provideCompletionItems(model, position) {
      if (contribution.language === 'cpp' && isCFile(model.uri.path)) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // Only the owner's members belong after a dot; global symbols would otherwise
      // flood every member access with unrelated Arduino functions.
      const access = /([A-Za-z_]\w*)\s*\.\s*\w*$/.exec(linePrefix);
      if (access) {
        const group = contribution.members?.find((candidate) => candidate.owner === access[1]);
        return {
          suggestions: group ? group.members.map((entry) => toSuggestion(monaco, entry, range)) : [],
        };
      }
      const entries = [...(contribution.snippets ?? []), ...(contribution.symbols ?? [])];
      return { suggestions: entries.map((entry) => toSuggestion(monaco, entry, range)) };
    },
  };
}

function createHoverProvider(
  monaco: MonacoApi,
  contribution: LanguageCompletions,
): Monaco.languages.HoverProvider {
  const entries = [
    ...(contribution.symbols ?? []),
    ...(contribution.snippets ?? []),
    ...(contribution.members ?? []).flatMap((group) => group.members),
  ];
  return {
    provideHover(model, position) {
      if (contribution.language === 'cpp' && isCFile(model.uri.path)) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const entry = entries.find((candidate) => candidate.name === word.word);
      if (!entry) return null;
      const contents: Monaco.IMarkdownString[] = [{ value: `\`\`\`cpp\n${entry.detail}\n\`\`\`` }];
      if (entry.documentation) contents.push({ value: entry.documentation });
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents,
      };
    },
  };
}

interface CompletionScope {
  __blodeCompletionDisposables?: Monaco.IDisposable[];
}

let projectFiles: readonly CompletionFile[] = [];
let projectRoot = '';
let cStandard: CStandard = 'c17';
let moduleLanguage: ModuleLanguageState | undefined;
let moduleSignature = '';
const workspaceIndex = new WorkspaceLanguageIndex();
const languageRules = new LanguageRuleCache();
const moduleLanguageCache = new ModuleLanguageCache();
let catalog: Pick<AiAssistanceState, 'useBuiltins' | 'entries'> = { useBuiltins: true, entries: [] };
let registeredMonaco: MonacoApi | undefined;
/** Refreshed immediately after either a user or the external AI edits the catalog. */
export function setCompletionCatalog(next: Pick<AiAssistanceState, 'useBuiltins' | 'entries'>): void {
  if (JSON.stringify(catalog) === JSON.stringify({ useBuiltins: next.useBuiltins, entries: next.entries }))
    return;
  catalog = { useBuiltins: next.useBuiltins, entries: next.entries };
  languageRules.update(projectFiles, cStandard, catalog.useBuiltins, projectRoot);
  cCatalogCache.clear();
  if (registeredMonaco) registerCompletions(registeredMonaco);
}
let projectVersion = 0;
const cCache = new Map<string, CompletionEntry[]>();

/** The workspace publishes text files + drafts for recursive include parsing. */
export function setCompletionProject(
  files: readonly CompletionFile[],
  options: { projectRoot?: string; cStandard?: CStandard; language?: ModuleLanguageState } = {},
): void {
  const { state: nextLanguage, signature } = moduleLanguageCache.update(
    options.language,
    files,
    options.cStandard ?? 'c17',
  );
  const languageChanged = signature !== moduleSignature;
  moduleLanguage = nextLanguage;
  moduleSignature = signature;
  projectFiles = files;
  if (options.projectRoot !== undefined && options.projectRoot !== projectRoot) definitionOrigins.clear();
  projectRoot = options.projectRoot ?? projectRoot;
  cStandard = options.cStandard ?? 'c17';
  const symbolsChanged = workspaceIndex.update(files);
  const legacyChanged =
    files.find((file) => file.path === 'blode.completions.json')?.content !== legacyContent;
  legacyContent = files.find((file) => file.path === 'blode.completions.json')?.content;
  if (symbolsChanged || legacyChanged) {
    projectVersion += 1;
    cCache.clear();
  }
  languageRules.update(files, cStandard, catalog.useBuiltins, projectRoot);
  cCatalogCache.clear();
  scheduleRuleDiagnostics();
  if (languageChanged && registeredMonaco) registerCompletions(registeredMonaco);
}

let legacyContent: string | undefined;
const cCatalogCache = new Map<string, LanguageCompletions>();
const moduleContribution = (path: string): LanguageCompletions | undefined => {
  const entry = moduleLanguage && moduleLanguageForFile(moduleLanguage, path);
  if (!entry) return undefined;
  const project = ['c', 'cpp'].includes(entry.id) ? cCompletions(path) : [];
  return (
    resolveCompletionCatalog(
      [
        ...(catalog.useBuiltins ? entry.contributions : []),
        ...(entry.userContributions ?? []),
        { language: entry.editorLanguage, symbols: project },
      ],
      catalog.entries
        .filter((item) => item.language === entry.editorLanguage || item.language === entry.id)
        .map((item) => ({ ...item, language: entry.editorLanguage })),
      true,
    )[0] ?? { language: entry.editorLanguage }
  );
};
const cContribution = (path: string) => {
  let contribution = cCatalogCache.get(path);
  if (!contribution) {
    contribution = resolveCCompletionCatalog(
      languageRules.pack().contribution,
      cCompletions(path),
      catalog.entries,
    );
    cCatalogCache.set(path, contribution);
  }
  return contribution;
};
function isCFile(path: string): boolean {
  const file = activeProjectPath(path);
  if (/\.c$/.test(file)) return true;
  if (!/\.h$/i.test(file)) return false;
  return (
    projectFiles.some((item) => /\.c$/.test(item.path)) ||
    !projectFiles.some((item) => /\.(?:cpp|cc|cxx|ino)$/i.test(item.path))
  );
}
let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
const markerState = new WeakMap<Monaco.editor.ITextModel, string>();
function scheduleRuleDiagnostics(): void {
  clearTimeout(diagnosticTimer);
  if (!registeredMonaco) return;
  diagnosticTimer = setTimeout(() => {
    const monaco = registeredMonaco!;
    for (const model of monaco.editor.getModels()) {
      const path = activeProjectPath(model.uri.path);
      if (!path) continue;
      const diagnostics = moduleLanguage
        ? [
            ...moduleLanguage.diagnostics.filter((item) => item.file === path),
            ...analyzeModuleLanguageRules(
              moduleLanguage,
              projectFiles.filter((file) => file.path === path),
            ),
          ]
        : languageRules.diagnostics(path);
      const state = JSON.stringify(diagnostics);
      if (markerState.get(model) === state) continue;
      markerState.set(model, state);
      monaco.editor.setModelMarkers(
        model,
        'blode-language-rules',
        diagnostics.map((item) => ({
          severity: item.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: item.message,
          startLineNumber: item.line,
          startColumn: item.column,
          endLineNumber: item.endLine ?? item.line,
          endColumn: item.endColumn ?? item.column + 1,
          ...(item.rule ? { code: item.rule } : {}),
        })),
      );
    }
  }, 180);
}

function cCompletions(activePath: string): CompletionEntry[] {
  const key = `${projectVersion}:${activePath}`;
  const cached = cCache.get(key);
  if (cached) return cached;
  const entries = parseCustomCCompletions(projectFiles);
  const names = new Set(entries.map((entry) => entry.name));
  for (const symbol of workspaceIndex.snapshot().symbols) {
    if (names.has(symbol.name) || (symbol.local && symbol.path !== activePath)) continue;
    names.add(symbol.name);
    entries.push({
      name: symbol.name,
      kind: symbol.kind === 'macro' ? 'constant' : symbol.kind,
      detail: `${symbol.signature} · ${symbol.path}:${symbol.line}`,
      documentation: `\`${symbol.path}:${symbol.line}\``,
      insertText: symbol.kind === 'function' ? `${symbol.name}(\${1:})` : symbol.name,
    });
  }
  cCache.set(key, entries);
  return entries;
}

function activeProjectPath(uriPath: string): string {
  let decoded = uriPath.replaceAll('\\', '/');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* Literal percent in a native filename. */
  }
  const normalized = decoded.replace(/^\/+/, '');
  const root = normalizeSourcePath(projectRoot).replace(/^\/+|\/+$/g, '');
  if (root) {
    if (!normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) return '';
    const relative = normalized.slice(root.length + 1);
    return projectFiles.find((file) => normalizeSourcePath(file.path) === relative)?.path ?? '';
  }
  const match = projectFiles.find(
    (file) =>
      normalized === file.path.replaceAll('\\', '/') ||
      normalized.endsWith(`/${file.path.replaceAll('\\', '/')}`),
  );
  return match?.path ?? normalized.split('/').slice(-1)[0] ?? '';
}

const navigationModels = new Map<string, ReturnType<typeof setTimeout>>();
const definitionOrigins = new Map<string, SourceLocation>();
/** Capture before Peek changes the source editor's selection. */
export function definitionOriginForUri(uriPath: string): SourceLocation | undefined {
  return definitionOrigins.get(activeProjectPath(uriPath));
}
function targetLocation(monaco: MonacoApi, target: SourceLocation): Monaco.languages.Location {
  const uri = monaco.Uri.file(`${projectRoot}/${target.path}`);
  const key = uri.toString();
  const text = workspaceIndex.source(target.path);
  if (text !== undefined && !monaco.editor.getModel(uri)) {
    monaco.editor.createModel(text, 'cpp', uri);
    const release = () => {
      if (monaco.editor.getEditors().some((editor) => editor.getModel()?.uri.toString() === key)) {
        navigationModels.set(key, setTimeout(release, 10000));
        return;
      }
      monaco.editor.getModel(uri)?.dispose();
      navigationModels.delete(key);
    };
    navigationModels.set(key, setTimeout(release, 10000));
  }
  return { uri, range: new monaco.Range(target.line, target.column, target.endLine, target.endColumn) };
}

function languageNavigation(monaco: MonacoApi, declaration = false): Monaco.languages.DefinitionProvider {
  return {
    provideDefinition(model, position) {
      const path = activeProjectPath(model.uri.path);
      if (path)
        definitionOrigins.set(path, {
          path,
          line: position.lineNumber,
          column: position.column,
          endLine: position.lineNumber,
          endColumn: position.column,
        });
      const include = workspaceIndex
        .snapshot()
        .includes.find(
          (item) =>
            item.path === path &&
            item.line === position.lineNumber &&
            position.column >= item.column &&
            position.column <= item.endColumn,
        );
      if (include)
        return workspaceIndex
          .resolveInclude(path, include.specifier)
          .map((file) =>
            targetLocation(monaco, { path: file, line: 1, column: 1, endLine: 1, endColumn: 1 }),
          );
      const word = model.getWordAtPosition(position);
      if (!word) return [];
      return workspaceIndex
        .definitions(word.word, path, declaration)
        .map((target) => targetLocation(monaco, target));
    },
  };
}

export function sourcePathForUri(uriPath: string): string | undefined {
  const path = activeProjectPath(uriPath);
  return projectFiles.some((file) => normalizeSourcePath(file.path) === path) ? path : undefined;
}

function createCProvider(monaco: MonacoApi, language: string): Monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: [
      ...new Set([
        ...(['c', 'cpp'].includes(language) ? ['.', '#', '>'] : []),
        ...(moduleLanguage?.entries
          .filter((entry) => entry.editorLanguage === language)
          .flatMap((entry) =>
            [...entry.contributions, ...(entry.userContributions ?? [])].flatMap(
              (pack) => pack.triggerCharacters ?? [],
            ),
          ) ?? []),
      ]),
    ],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const activePath = activeProjectPath(model.uri.path);
      if (!activePath) return { suggestions: [] };
      if (moduleLanguage && !moduleLanguageForFile(moduleLanguage, activePath)) return { suggestions: [] };
      const contribution = moduleLanguage
        ? moduleContribution(activePath)
        : isCFile(model.uri.path)
          ? cContribution(activePath)
          : undefined;
      const access = /([A-Za-z_]\w*)\s*(?:\.|->)\s*\w*$/.exec(linePrefix);
      if (access)
        return {
          suggestions: (contribution?.members?.find((group) => group.owner === access[1])?.members ?? []).map(
            (entry) => toSuggestion(monaco, entry, range),
          ),
        };
      const entries = contribution
        ? [...(contribution.snippets ?? []), ...(contribution.symbols ?? [])]
        : cCompletions(activePath);
      return {
        suggestions: entries.map((entry) => toSuggestion(monaco, entry, range)),
      };
    },
  };
}

function createCDynamicHover(monaco: MonacoApi): Monaco.languages.HoverProvider {
  return {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      if (moduleLanguage && !moduleLanguageForFile(moduleLanguage, activeProjectPath(model.uri.path)))
        return null;
      const contribution = moduleLanguage
        ? moduleContribution(activeProjectPath(model.uri.path))
        : isCFile(model.uri.path)
          ? cContribution(activeProjectPath(model.uri.path))
          : undefined;
      const prefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: word.startColumn,
      });
      const access = /([A-Za-z_]\w*)\s*(?:\.|->)\s*$/.exec(prefix);
      const entries = access
        ? (contribution?.members?.find((group) => group.owner === access[1])?.members ?? [])
        : contribution
          ? [...(contribution.symbols ?? []), ...(contribution.snippets ?? [])]
          : cCompletions(activeProjectPath(model.uri.path));
      const entry = entries.find((candidate) => candidate.name === word.word);
      if (!entry) return null;
      const contents: Monaco.IMarkdownString[] = [{ value: `\`\`\`c\n${entry.detail}\n\`\`\`` }];
      if (entry.documentation) contents.push({ value: entry.documentation });
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents,
      };
    },
  };
}

/**
 * Converts every registered language pack into Monaco providers. Called once from
 * the editor module; a global disposal slot keeps Vite hot reload from stacking
 * duplicate providers.
 */
export function registerCompletions(monaco: MonacoApi): void {
  registeredMonaco = monaco;
  scheduleRuleDiagnostics();
  const scope = globalThis as typeof globalThis & CompletionScope;
  scope.__blodeCompletionDisposables?.forEach((disposable) => disposable.dispose());
  const disposables: Monaco.IDisposable[] = [];
  disposables.push(monaco.editor.onDidCreateModel(() => scheduleRuleDiagnostics()));
  for (const contribution of resolveCompletionCatalog(
    moduleLanguage ? [] : listLanguageCompletions(),
    moduleLanguage ? [] : catalog.entries,
    catalog.useBuiltins,
  )) {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(
        contribution.language,
        createProvider(monaco, contribution),
      ),
    );
    disposables.push(
      monaco.languages.registerHoverProvider(
        contribution.language,
        createHoverProvider(monaco, contribution),
      ),
    );
  }
  // Project-aware C/C++ symbols are dynamic: the parser sees current drafts and
  // recursively resolves quoted headers, so it is registered separately from
  // the static data packs.
  for (const language of new Set([
    'cpp',
    'c',
    ...(moduleLanguage?.entries.map((entry) => entry.editorLanguage) ?? []),
  ])) {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(language, createCProvider(monaco, language)),
    );
    disposables.push(monaco.languages.registerHoverProvider(language, createCDynamicHover(monaco)));
    if (!['cpp', 'c'].includes(language)) continue;
    disposables.push(monaco.languages.registerDefinitionProvider(language, languageNavigation(monaco)));
    const declaration = languageNavigation(monaco, true);
    disposables.push(
      monaco.languages.registerDeclarationProvider(language, {
        provideDeclaration: (model, position, token) => declaration.provideDefinition(model, position, token),
      }),
    );
    disposables.push(
      monaco.languages.registerLinkProvider(language, {
        provideLinks(model) {
          const path = activeProjectPath(model.uri.path);
          return {
            links: workspaceIndex
              .snapshot()
              .includes.filter((item) => item.path === path)
              .flatMap((item) => {
                const targets = workspaceIndex.resolveInclude(path, item.specifier);
                // Ambiguous headers use F12/Peek, which can show all matching paths.
                if (targets.length !== 1) return [];
                return [
                  {
                    range: new monaco.Range(item.line, item.column, item.endLine, item.endColumn),
                    url: targetLocation(monaco, {
                      path: targets[0],
                      line: 1,
                      column: 1,
                      endLine: 1,
                      endColumn: 1,
                    }).uri,
                    tooltip: targets[0],
                  },
                ];
              }),
          };
        },
      }),
    );
  }
  scope.__blodeCompletionDisposables = disposables;
}
