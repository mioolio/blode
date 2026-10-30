import type * as Monaco from 'monaco-editor';
import { WorkspaceLanguageIndex, normalizeSourcePath } from '../../shared/language-index';
import type {
  LanguageExternalSource,
  LanguageNavigationRequest,
  SourceLocation,
} from '../../shared/language';
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
import { NavigationRequests, yieldNavigation, type NavigationCancellation } from './navigationRequests';
import { refreshExternalModel } from './externalModelUpdates';
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
let projectPaths = new Map<string, string>();
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
  projectPaths = new Map(files.map((file) => [normalizeSourcePath(file.path), file.path]));
  const rootChanged = options.projectRoot !== undefined && options.projectRoot !== projectRoot;
  if (rootChanged) {
    definitionOrigins = new WeakMap();
    externalSources.clear();
  }
  projectRoot = options.projectRoot ?? projectRoot;
  cStandard = options.cStandard ?? 'c17';
  const symbolsChanged = workspaceIndex.update(files);
  const legacyChanged =
    files.find((file) => file.path === 'blode.completions.json')?.content !== legacyContent;
  legacyContent = files.find((file) => file.path === 'blode.completions.json')?.content;
  if (symbolsChanged || legacyChanged || rootChanged || languageChanged) {
    projectVersion += 1;
    cCache.clear();
    navigationRequests.reset();
    pendingExternalSources.clear();
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
    return projectPaths.get(relative) ?? '';
  }
  const match = projectFiles.find(
    (file) =>
      normalized === file.path.replaceAll('\\', '/') ||
      normalized.endsWith(`/${file.path.replaceAll('\\', '/')}`),
  );
  return match?.path ?? normalized.split('/').slice(-1)[0] ?? '';
}

const navigationModels = new Map<string, ReturnType<typeof setTimeout>>();
let definitionOrigins = new WeakMap<
  Monaco.editor.ICodeEditor,
  { root: string; model: Monaco.editor.ITextModel; version: number; origin: SourceLocation }
>();
const externalSources = new Map<string, LanguageExternalSource>();
export function registerExternalSource(
  source: LanguageExternalSource,
  options: { fresh?: boolean } = {},
): void {
  if (
    source.readonly !== true ||
    !/^[a-f0-9]{32}$/.test(source.id) ||
    !source.path.startsWith(`@external/${source.id}/`)
  )
    throw new Error('error.invalidPath');
  const previous = externalSources.get(source.id);
  if (previous && !options.fresh) return;
  externalSources.set(source.id, source);
  if (
    (!previous ||
      previous.content !== source.content ||
      previous.path !== source.path ||
      previous.displayPath !== source.displayPath ||
      previous.name !== source.name) &&
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function'
  )
    window.dispatchEvent(
      new CustomEvent('blode:external-source-updated', { detail: { root: projectRoot, source } }),
    );
}
/** External navigation models are read-only capabilities, never workspace drafts. */
export function externalSourceForUri(uriPath: string): LanguageExternalSource | undefined {
  let decoded = uriPath.replaceAll('\\', '/');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* Native percent in a filename. */
  }
  const id = /\/@external\/([a-f0-9]{32})\//.exec(decoded)?.[1];
  const source = id ? externalSources.get(id) : undefined;
  if (source && decoded.endsWith('/' + source.path)) return source;
  return;
}
function navigationPath(uriPath: string): string {
  return externalSourceForUri(uriPath)?.path ?? activeProjectPath(uriPath);
}
/** Capture before Peek changes the source editor's selection. */
export function definitionOriginForEditor(editor: Monaco.editor.ICodeEditor): SourceLocation | undefined {
  const visited = new Set<Monaco.editor.ICodeEditor>();
  let current: Monaco.editor.ICodeEditor | null = editor;
  while (current && !visited.has(current)) {
    visited.add(current);
    const saved = definitionOrigins.get(current),
      model = current.getModel();
    if (
      saved &&
      saved.root === projectRoot &&
      model === saved.model &&
      !model.isDisposed() &&
      model.getVersionId() === saved.version
    )
      return saved.origin;
    const parent: (() => Monaco.editor.ICodeEditor | null) | undefined = (
      current as Monaco.editor.ICodeEditor & { getParentEditor?: () => Monaco.editor.ICodeEditor | null }
    ).getParentEditor;
    if (!parent) break;
    current = parent.call(current);
  }
}
function requestEditor(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  position: Monaco.IPosition,
): Monaco.editor.ICodeEditor | undefined {
  return monaco.editor.getEditors?.().find((editor) => {
    const cursor = editor.getPosition();
    return (
      editor.getModel() === model &&
      (editor.hasTextFocus() || editor.hasWidgetFocus()) &&
      cursor?.lineNumber === position.lineNumber &&
      cursor.column === position.column
    );
  });
}
const pendingExternalSources = new Map<string, Promise<LanguageExternalSource>>();
const externalIndexes = new WeakMap<
  Monaco.editor.ITextModel,
  { version: number | undefined; path: string; index: WorkspaceLanguageIndex }
>();
function parsedModel(
  model: Monaco.editor.ITextModel,
  path: string,
  external?: LanguageExternalSource,
): WorkspaceLanguageIndex {
  if (!external) return workspaceIndex;
  const version = model.getVersionId?.(),
    cached = externalIndexes.get(model);
  if (cached && cached.version === version && cached.path === path) return cached.index;
  const index = new WorkspaceLanguageIndex();
  index.update([{ path, content: model.getValue() }]);
  externalIndexes.set(model, { version, path, index });
  return index;
}
function navigationGuard(model: Monaco.editor.ITextModel, token: NavigationCancellation) {
  const root = projectRoot,
    generation = projectVersion,
    version = model.getVersionId?.();
  return () =>
    !token.isCancellationRequested &&
    !model.isDisposed?.() &&
    root === projectRoot &&
    generation === projectVersion &&
    version === model.getVersionId?.();
}
async function targetLocation(
  monaco: MonacoApi,
  target: SourceLocation,
  current: () => boolean,
  refreshed = new Set<string>(),
): Promise<Monaco.languages.Location | undefined> {
  if (!current()) return;
  const root = projectRoot;
  if (target.externalId && !refreshed.has(target.externalId)) {
    const key = `${root}:${target.externalId}`;
    let pending = pendingExternalSources.get(key);
    if (!pending) {
      pending = window.blode.languageOpenExternal({
        expectedProjectRoot: root,
        externalId: target.externalId,
      });
      pendingExternalSources.set(key, pending);
      void pending
        .finally(() => {
          if (pendingExternalSources.get(key) === pending) pendingExternalSources.delete(key);
        })
        .catch(() => {});
    }
    let source: LanguageExternalSource;
    try {
      source = await pending;
    } catch (error) {
      if (!current()) return;
      throw error;
    }
    if (!current() || root !== projectRoot) return;
    registerExternalSource(source, { fresh: true });
    refreshed.add(target.externalId);
  }
  const uri = monaco.Uri.file(`${projectRoot}/${target.path}`);
  const key = uri.toString();
  const text = target.externalId
    ? externalSources.get(target.externalId)?.content
    : workspaceIndex.source(target.path);
  const existing = monaco.editor.getModel(uri);
  if (target.externalId && text !== undefined && existing) refreshExternalModel(existing, text);
  if (text !== undefined && !existing) {
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
async function targetLocations(
  monaco: MonacoApi,
  targets: SourceLocation[],
  current: () => boolean,
): Promise<Monaco.languages.Location[]> {
  const result: Monaco.languages.Location[] = [];
  const refreshed = new Set<string>();
  let sliceStarted = performance.now();
  for (let index = 0; index < targets.length; index++) {
    if (!current()) return [];
    const location = await targetLocation(monaco, targets[index], current, refreshed);
    if (!location) return [];
    result.push(location);
    if (performance.now() - sliceStarted >= 6) {
      await yieldNavigation();
      sliceStarted = performance.now();
    }
  }
  return current() ? result : [];
}

function languageNavigation(monaco: MonacoApi, declaration = false): Monaco.languages.DefinitionProvider {
  return {
    async provideDefinition(model, position, token) {
      const current = navigationGuard(model, token);
      const sourceEditor = requestEditor(monaco, model, position);
      if (!current()) return [];
      await yieldNavigation();
      if (!current()) return [];
      const root = projectRoot,
        path = navigationPath(model.uri.path),
        external = externalSourceForUri(model.uri.path);
      if (!path) return [];
      const parsed = parsedModel(model, path, external);
      const specifier = parsed
        .includesForPath(path)
        .find(
          (item) =>
            item.path === path &&
            item.line === position.lineNumber &&
            position.column >= item.column &&
            position.column <= item.endColumn,
        )?.specifier;
      const word = model.getWordAtPosition(position);
      if (!specifier && !word) return [];
      const local: SourceLocation[] =
        specifier && !external
          ? workspaceIndex
              .resolveInclude(path, specifier)
              .map((file) => ({ path: file, line: 1, column: 1, endLine: 1, endColumn: 1 }))
          : specifier
            ? []
            : workspaceIndex.definitions(word!.word, path, declaration);
      const targets = local.length
        ? local
        : await hostNavigation(
            {
              expectedProjectRoot: root,
              path,
              ...(external ? { externalId: external.id } : {}),
              kind: specifier ? 'include' : declaration ? 'declaration' : 'definition',
              ...(specifier ? { specifier } : { symbol: word!.word }),
            },
            token,
            current,
          );
      if (!current()) return [];
      const locations = await targetLocations(monaco, targets, current);
      if (locations.length && current() && sourceEditor && sourceEditor.getModel() === model)
        definitionOrigins.set(sourceEditor, {
          root,
          model,
          version: model.getVersionId(),
          origin: {
            path,
            ...(external ? { externalId: external.id } : {}),
            line: position.lineNumber,
            column: position.column,
            endLine: position.lineNumber,
            endColumn: position.column,
          },
        });
      return locations;
    },
  };
}

const navigationRequests = new NavigationRequests({
  invoke: (request) => window.blode.languageNavigate(request),
  cancel: (request) => window.blode.languageCancel?.(request) ?? Promise.resolve(),
});
async function hostNavigation(
  request: LanguageNavigationRequest,
  token: NavigationCancellation,
  current: () => boolean,
): Promise<SourceLocation[]> {
  if (
    !request.expectedProjectRoot ||
    !request.path ||
    typeof window === 'undefined' ||
    !window.blode?.languageNavigate
  )
    return [];
  if (request.kind !== 'include' && !/^[A-Za-z_]\w{0,255}$/.test(request.symbol ?? '')) return [];
  if (request.kind === 'include' && (!request.specifier || request.specifier.length > 1024)) return [];
  return navigationRequests.query(request, token, current);
}

export function sourcePathForUri(uriPath: string): string | undefined {
  const external = externalSourceForUri(uriPath);
  if (external) return external.path;
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
        async provideLinks(model, token) {
          if (token.isCancellationRequested || model.isDisposed?.()) return { links: [] };
          const root = projectRoot,
            path = navigationPath(model.uri.path),
            external = externalSourceForUri(model.uri.path);
          // Only explicit header links trigger host I/O. Resolve lazily when the user opens one.
          if (!path) return { links: [] };
          const includes = parsedModel(model, path, external).includesForPath(path);
          return {
            links: includes.map((item) => ({
              range: new monaco.Range(item.line, item.column, item.endLine, item.endColumn),
              tooltip: item.specifier,
              _blodeInclude: {
                root,
                path,
                specifier: item.specifier,
                externalId: external?.id,
                generation: projectVersion,
                model,
                version: model.getVersionId?.(),
              },
            })),
          };
        },
        async resolveLink(link, token) {
          const request = (
            link as typeof link & {
              _blodeInclude?: {
                root: string;
                path: string;
                specifier: string;
                externalId?: string;
                generation: number;
                model: Monaco.editor.ITextModel;
                version?: number;
              };
            }
          )._blodeInclude;
          if (!request) return link;
          const current = () =>
            !token.isCancellationRequested &&
            request.root === projectRoot &&
            request.generation === projectVersion &&
            !request.model.isDisposed?.() &&
            request.version === request.model.getVersionId?.();
          if (!current()) return link;
          await yieldNavigation();
          if (!current()) return link;
          const local = request.externalId
            ? []
            : workspaceIndex
                .resolveInclude(request.path, request.specifier)
                .map((path) => ({ path, line: 1, column: 1, endLine: 1, endColumn: 1 }));
          const targets = local.length
            ? local
            : await hostNavigation(
                {
                  expectedProjectRoot: request.root,
                  path: request.path,
                  externalId: request.externalId,
                  kind: 'include',
                  specifier: request.specifier,
                },
                token,
                current,
              );
          if (!current() || targets.length !== 1) return link;
          const target = await targetLocation(monaco, targets[0], current);
          return target && current() ? { ...link, url: target.uri } : link;
        },
      }),
    );
    disposables.push(
      monaco.languages.registerReferenceProvider(language, {
        async provideReferences(model, position, _context, token) {
          const current = navigationGuard(model, token);
          const sourceEditor = requestEditor(monaco, model, position);
          if (!current()) return [];
          await yieldNavigation();
          if (!current()) return [];
          const root = projectRoot,
            path = navigationPath(model.uri.path),
            word = model.getWordAtPosition(position),
            external = externalSourceForUri(model.uri.path);
          if (!word || !path) return [];
          const remotePromise = hostNavigation(
            {
              expectedProjectRoot: root,
              path,
              externalId: external?.id,
              kind: 'reference',
              symbol: word.word,
            },
            token,
            current,
          );
          const [local, remote] = await Promise.all([
            workspaceIndex.referencesAsync(word.word, {
              cancelled: () => !current(),
              yieldControl: yieldNavigation,
            }),
            remotePromise,
          ]);
          if (!current()) return [];
          // Current draft references replace the saved version for every loaded workspace file.
          const targets = [
            ...local,
            ...remote.filter(
              (target) => target.externalId || !projectPaths.has(normalizeSourcePath(target.path)),
            ),
          ];
          const locations = await targetLocations(monaco, targets, current);
          if (locations.length && current() && sourceEditor && sourceEditor.getModel() === model)
            definitionOrigins.set(sourceEditor, {
              root,
              model,
              version: model.getVersionId(),
              origin: {
                path,
                ...(external ? { externalId: external.id } : {}),
                line: position.lineNumber,
                column: position.column,
                endLine: position.lineNumber,
                endColumn: position.column,
              },
            });
          return locations;
        },
      }),
    );
  }
  scope.__blodeCompletionDisposables = disposables;
}
