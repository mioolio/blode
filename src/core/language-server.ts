import path from 'node:path';
import { WorkspaceLanguageIndex, normalizeSourcePath } from '../shared/language-index';
import type {
  LanguageExternalSource,
  LanguageNavigationRequest,
  LanguageSource,
  LanguageSymbol,
  SourceLocation,
} from '../shared/language';
import type { AppState } from '../shared/contracts';
import {
  LSP_COMPLETION_ITEM_KIND,
  LSP_INSERT_TEXT_FORMAT,
  LSP_TEXT_DOCUMENT_SYNC_KIND,
  workspacePathFromLspUri,
  type LspCompletionItem,
  type LspCompletionList,
  type LspHover,
  type LspInitializeResult,
  type LspPosition,
  type LspRange,
  type LspRequestMethod,
} from '../shared/lsp';
import {
  lspCompletionParamsSchema,
  lspDidChangeParamsSchema,
  lspDidCloseParamsSchema,
  lspDidOpenParamsSchema,
  lspHoverParamsSchema,
  type LspNotifyInput,
  type LspRequestInput,
} from './lsp-schemas';

const MAX_DOCUMENTS = 64;
const MAX_DOCUMENT_CHARS = 1_000_000;
const MAX_COMPLETIONS = 600;
const MAX_EXTERNAL_SYMBOLS = 1_200;
const MAX_INCLUDES = 12;
const INDEX_REFRESH_MS = 1_000;
const HEADER_CACHE_MS = 15_000;
const EXTERNAL_CACHE_MS = 20_000;

export interface LanguageServerCore {
  workspaceSnapshot(): Promise<Pick<AppState, 'projectRoot' | 'files'>>;
  currentProjectRoot(): string;
}
export interface LanguageServerNavigation {
  navigate(request: LanguageNavigationRequest): Promise<SourceLocation[]>;
  openExternal(request: { expectedProjectRoot: string; externalId: string }): Promise<LanguageExternalSource>;
}

interface OpenDocument {
  root: string;
  path: string;
  version: number;
  text: string;
}
interface IndexState {
  root: string;
  updated: number;
  /** Open-document text already merged into the index, per project path. */
  documents: Map<string, string>;
  value: WorkspaceLanguageIndex;
}
interface HeaderRecord {
  expires: number;
  symbols: LanguageSymbol[];
}
interface ExternalRecord {
  expires: number;
  displayPath: string;
  symbols: LanguageSymbol[];
}

const kindRank = (kind: LanguageSymbol['kind']): string => {
  switch (kind) {
    case 'function':
      return '1';
    case 'type':
      return '2';
    case 'variable':
      return '3';
    default:
      return '4';
  }
};
const completionKind = (kind: LanguageSymbol['kind']): number => {
  switch (kind) {
    case 'function':
      return LSP_COMPLETION_ITEM_KIND.function;
    case 'type':
      return LSP_COMPLETION_ITEM_KIND.struct;
    case 'variable':
      return LSP_COMPLETION_ITEM_KIND.variable;
    default:
      return LSP_COMPLETION_ITEM_KIND.constant;
  }
};
const isWord = (character: string | undefined) => !!character && /[A-Za-z0-9_]/.test(character);

/** Zero-based UTF-16 LSP position to a string offset; invalid positions are rejected. */
function offsetAt(text: string, position: LspPosition): number | undefined {
  if (position.line < 0 || position.character < 0) return undefined;
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return undefined;
    offset = next + 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const end = lineEnd < 0 ? text.length : lineEnd;
  if (offset + position.character > end) return undefined;
  return offset + position.character;
}
function positionAt(text: string, offset: number): LspPosition {
  let line = 0;
  let lineStart = 0;
  for (let index = text.indexOf('\n'); index >= 0 && index < offset;) {
    line++;
    lineStart = index + 1;
    index = text.indexOf('\n', lineStart);
  }
  return { line, character: offset - lineStart };
}
function wordAt(text: string, offset: number): { text: string; start: number; end: number } | undefined {
  let start = offset;
  let end = offset;
  if (start > 0 && !isWord(text[start]) && isWord(text[start - 1])) start -= 1;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  const word = text.slice(start, end);
  if (!/^[A-Za-z_]\w*$/.test(word)) return undefined;
  return { text: word, start, end };
}
function wordRange(text: string, start: number, end: number): LspRange {
  return { start: positionAt(text, start), end: positionAt(text, end) };
}

/**
 * A host-side language server that answers a small LSP subset from the same
 * incremental source index used by navigation, plus include-resolved headers.
 */
export class WorkspaceLanguageServer {
  private documents = new Map<string, OpenDocument>();
  private index: IndexState | undefined;
  private headers = new Map<string, HeaderRecord>();
  private external = new Map<string, ExternalRecord>();

  constructor(
    private readonly options: {
      core: LanguageServerCore;
      navigation: LanguageServerNavigation;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private requireRoot(expected: string): string {
    const current = this.options.core.currentProjectRoot();
    if (!expected || !current || path.resolve(expected) !== path.resolve(current))
      throw new Error('error.collaborationProjectChanged');
    return current;
  }
  private key(root: string, file: string): string {
    return `${root}\0${file}`;
  }
  private documentPath(uri: string): string {
    const file = workspacePathFromLspUri(uri);
    if (!file) throw new Error('rpc.invalidParams');
    return file;
  }
  private open(root: string, params: { textDocument: { uri: string; version: number; text: string } }) {
    const file = this.documentPath(params.textDocument.uri);
    if (params.textDocument.text.length > MAX_DOCUMENT_CHARS) throw new Error('rpc.limitExceeded');
    for (const [key, document] of this.documents) if (document.root !== root) this.documents.delete(key);
    const key = this.key(root, file);
    this.documents.delete(key);
    this.documents.set(key, {
      root,
      path: file,
      version: params.textDocument.version,
      text: params.textDocument.text,
    });
    while (this.documents.size > MAX_DOCUMENTS) this.documents.delete(this.documents.keys().next().value!);
    this.index = undefined;
  }
  private change(
    root: string,
    params: { textDocument: { uri: string; version: number }; contentChanges: { text: string }[] },
  ) {
    const file = this.documentPath(params.textDocument.uri);
    const text = params.contentChanges[params.contentChanges.length - 1]?.text ?? '';
    if (text.length > MAX_DOCUMENT_CHARS) throw new Error('rpc.limitExceeded');
    const key = this.key(root, file);
    this.documents.delete(key);
    this.documents.set(key, {
      root,
      path: file,
      version: params.textDocument.version,
      text,
    });
    // The next request merges the changed buffer into the existing index.
  }
  private close(root: string, params: { textDocument: { uri: string } }) {
    const file = this.documentPath(params.textDocument.uri);
    this.documents.delete(this.key(root, file));
    this.index = undefined;
  }

  private async ensureIndex(root: string): Promise<WorkspaceLanguageIndex> {
    const documents = [...this.documents.values()].filter((document) => document.root === root);
    if (this.index?.root === root && this.now() - this.index.updated < INDEX_REFRESH_MS) {
      // Typing only re-parses the changed buffers; unchanged project files and
      // unchanged open documents are not touched.
      for (const document of documents) {
        if (this.index.documents.get(document.path) === document.text) continue;
        this.index.value.upsert([{ path: document.path, content: document.text }]);
        this.index.documents.set(document.path, document.text);
      }
      return this.index.value;
    }
    const workspace = await this.options.core.workspaceSnapshot();
    if (path.resolve(workspace.projectRoot) !== path.resolve(root))
      throw new Error('error.collaborationProjectChanged');
    const sources = new Map<string, LanguageSource>();
    for (const file of workspace.files)
      sources.set(normalizeSourcePath(file.path), { path: file.path, content: file.content });
    for (const document of documents)
      sources.set(normalizeSourcePath(document.path), {
        path: document.path,
        content: document.text,
      });
    const value = new WorkspaceLanguageIndex();
    value.update([...sources.values()]);
    this.index = {
      root,
      updated: this.now(),
      documents: new Map(documents.map((document) => [document.path, document.text])),
      value,
    };
    return value;
  }
  private async documentText(
    root: string,
    uri: string,
  ): Promise<{ path: string; text: string; index: WorkspaceLanguageIndex }> {
    const file = this.documentPath(uri);
    const document = this.documents.get(this.key(root, file));
    const index = await this.ensureIndex(root);
    const text = document?.text ?? index.source(file);
    if (text === undefined) throw new Error('error.languageSourceUnavailable');
    return { path: file, text, index };
  }

  private async externalSymbols(root: string, id: string): Promise<ExternalRecord | undefined> {
    const key = this.key(root, id);
    const cached = this.external.get(key);
    if (cached && cached.expires > this.now()) return cached;
    let source: LanguageExternalSource;
    try {
      source = await this.options.navigation.openExternal({
        expectedProjectRoot: root,
        externalId: id,
      });
    } catch {
      return undefined;
    }
    const index = new WorkspaceLanguageIndex();
    index.update([{ path: source.path, content: source.content }]);
    const record: ExternalRecord = {
      expires: this.now() + EXTERNAL_CACHE_MS,
      displayPath: source.displayPath,
      symbols: index.snapshot().symbols.map((symbol) => ({ ...symbol, externalId: id })),
    };
    this.external.set(key, record);
    while (this.external.size > 128) this.external.delete(this.external.keys().next().value!);
    return record;
  }
  private async headerSymbols(
    root: string,
    from: string,
    specifiers: readonly string[],
  ): Promise<LanguageSymbol[]> {
    const unique = [...new Set(specifiers)].slice(0, MAX_INCLUDES);
    if (!unique.length) return [];
    const key = `${root}\0${from}\0${unique.join('\0')}`;
    const cached = this.headers.get(key);
    if (cached && cached.expires > this.now()) return cached.symbols;
    const symbols: LanguageSymbol[] = [];
    for (const specifier of unique) {
      let locations: SourceLocation[] = [];
      try {
        locations = await this.options.navigation.navigate({
          expectedProjectRoot: root,
          path: from,
          kind: 'include',
          specifier,
        });
      } catch {
        continue;
      }
      for (const location of locations) {
        if (!location.externalId) continue;
        const external = await this.externalSymbols(root, location.externalId);
        if (!external) continue;
        symbols.push(...external.symbols);
        if (symbols.length >= MAX_EXTERNAL_SYMBOLS) break;
      }
      if (symbols.length >= MAX_EXTERNAL_SYMBOLS) break;
    }
    this.headers.set(key, { expires: this.now() + HEADER_CACHE_MS, symbols });
    while (this.headers.size > 64) this.headers.delete(this.headers.keys().next().value!);
    return symbols;
  }

  private completion(root: string, params: unknown): Promise<LspCompletionList> {
    const parsed = lspCompletionParamsSchema.safeParse(params);
    if (!parsed.success) throw new Error('rpc.invalidParams');
    const { textDocument, position } = parsed.data;
    return this.complete(root, textDocument.uri, position);
  }
  private async complete(root: string, uri: string, position: LspPosition): Promise<LspCompletionList> {
    const { path: file, text, index } = await this.documentText(root, uri);
    const offset = offsetAt(text, position);
    if (offset === undefined) throw new Error('rpc.invalidParams');
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const linePrefix = text.slice(lineStart, offset);
    // Member access needs type information; the declarative catalog owns those.
    if (/([A-Za-z_]\w*)\s*(?:\.|->)\s*\w*$/.test(linePrefix)) return { isIncomplete: false, items: [] };
    const prefix = /[A-Za-z_]\w*$/.exec(linePrefix)?.[0] ?? '';
    const range = wordRange(text, offset - prefix.length, offset);
    const seen = new Set<string>();
    const items: LspCompletionItem[] = [];
    const candidates: LanguageSymbol[] = [];
    for (const symbol of index.snapshot().symbols) {
      if (symbol.local && symbol.path !== file) continue;
      const name = symbol.name;
      if (seen.has(name)) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      seen.add(name);
      candidates.push(symbol);
      if (candidates.length >= MAX_COMPLETIONS) break;
    }
    candidates.sort(
      (a, b) =>
        Number(b.path === file) - Number(a.path === file) ||
        kindRank(a.kind).localeCompare(kindRank(b.kind)) ||
        a.name.localeCompare(b.name),
    );
    for (const symbol of candidates) items.push(this.completionItem(symbol, range));
    if (items.length < MAX_COMPLETIONS) {
      const includes = index.includesForPath(file).map((include) => include.specifier);
      const headers = await this.headerSymbols(root, file, includes);
      for (const symbol of headers) {
        if (items.length >= MAX_COMPLETIONS) break;
        if (seen.has(symbol.name)) continue;
        if (prefix && !symbol.name.startsWith(prefix)) continue;
        seen.add(symbol.name);
        items.push(this.completionItem(symbol, range));
      }
    }
    return { isIncomplete: items.length >= MAX_COMPLETIONS, items };
  }
  private completionItem(symbol: LanguageSymbol, range: LspRange): LspCompletionItem {
    const callable = symbol.kind === 'function';
    return {
      label: symbol.name,
      kind: completionKind(symbol.kind),
      detail: symbol.signature,
      sortText: `${kindRank(symbol.kind)}-${symbol.name}`,
      filterText: symbol.name,
      insertText: callable ? `${symbol.name}(\${1:})` : symbol.name,
      insertTextFormat: callable ? LSP_INSERT_TEXT_FORMAT.snippet : LSP_INSERT_TEXT_FORMAT.plainText,
      ...(symbol.kind === 'function' && !symbol.local
        ? { documentation: { kind: 'markdown' as const, value: `\`${symbol.path}:${symbol.line}\`` } }
        : {}),
      range,
    };
  }

  private hover(root: string, params: unknown): Promise<LspHover | null> {
    const parsed = lspHoverParamsSchema.safeParse(params);
    if (!parsed.success) throw new Error('rpc.invalidParams');
    return this.resolveHover(root, parsed.data.textDocument.uri, parsed.data.position);
  }
  private async resolveHover(root: string, uri: string, position: LspPosition): Promise<LspHover | null> {
    const { path: file, text, index } = await this.documentText(root, uri);
    const offset = offsetAt(text, position);
    if (offset === undefined) return null;
    const word = wordAt(text, offset);
    if (!word) return null;
    const local = index.definitions(word.text, file)[0];
    let symbol: LanguageSymbol | undefined = local;
    if (!symbol) {
      const includes = index.includesForPath(file).map((include) => include.specifier);
      symbol = (await this.headerSymbols(root, file, includes)).find(
        (candidate) => candidate.name === word.text,
      );
    }
    if (!symbol) return null;
    const display =
      (symbol.externalId && this.external.get(this.key(root, symbol.externalId))?.displayPath) || symbol.path;
    const value = `\`\`\`c\n${symbol.signature}\n\`\`\`\n\n\`${display}:${symbol.line}\``;
    return {
      contents: { kind: 'markdown', value },
      range: wordRange(text, word.start, word.end),
    };
  }

  private initialize(): LspInitializeResult {
    return {
      serverInfo: { name: 'blode-workspace-language-server', version: '1.0.0' },
      capabilities: {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: LSP_TEXT_DOCUMENT_SYNC_KIND.full },
        completionProvider: {
          triggerCharacters: ['.', '>', '#', ':'],
          resolveProvider: false,
        },
        hoverProvider: true,
      },
    };
  }

  /** Execute one client-to-server LSP request. Errors reject like JSON-RPC errors. */
  async request(input: LspRequestInput): Promise<unknown> {
    const root = this.requireRoot(input.expectedProjectRoot);
    switch (input.method as LspRequestMethod) {
      case 'initialize':
        return this.initialize();
      case 'shutdown':
        this.documents.clear();
        this.index = undefined;
        return null;
      case 'textDocument/completion':
        return this.completion(root, input.params);
      case 'textDocument/hover':
        return this.hover(root, input.params);
      default:
        throw new Error('rpc.methodNotFound');
    }
  }

  /** Apply a synchronously ordered batch of document notifications. */
  async notify(input: LspNotifyInput): Promise<void> {
    const root = this.requireRoot(input.expectedProjectRoot);
    const parsed = input.messages.map((message) => {
      switch (message.method) {
        case 'textDocument/didOpen': {
          const result = lspDidOpenParamsSchema.safeParse(message.params);
          if (!result.success) throw new Error('rpc.invalidParams');
          return { kind: 'open' as const, params: result.data };
        }
        case 'textDocument/didChange': {
          const result = lspDidChangeParamsSchema.safeParse(message.params);
          if (!result.success) throw new Error('rpc.invalidParams');
          return { kind: 'change' as const, params: result.data };
        }
        case 'textDocument/didClose': {
          const result = lspDidCloseParamsSchema.safeParse(message.params);
          if (!result.success) throw new Error('rpc.invalidParams');
          return { kind: 'close' as const, params: result.data };
        }
        default:
          throw new Error('rpc.methodNotFound');
      }
    });
    for (const message of parsed) {
      if (message.kind === 'open') this.open(root, message.params);
      else if (message.kind === 'change') this.change(root, message.params);
      else this.close(root, message.params);
    }
  }

  dispose(): void {
    this.documents.clear();
    this.headers.clear();
    this.external.clear();
    this.index = undefined;
  }
}
