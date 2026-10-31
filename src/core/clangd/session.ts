import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LspDiagnostic, LspPosition, LspPublishDiagnosticsParams } from '../../shared/lsp';
import type { SourceLocation } from '../../shared/language';
import type { ClangdTransport } from './transport';

const MAX_LOCATIONS = 1000;
/** clangd-only hints that the compiler does not report; keep the Problems list build-aligned. */
const IGNORED_DIAGNOSTIC_CODES = new Set(['unused-includes']);

export interface ClangdSessionOptions {
  transport: ClangdTransport;
  root: string;
  fallbackFlags: string[];
  now?: () => number;
}

interface DiagnosticRecord {
  items: LspDiagnostic[];
  version?: number;
  receivedAt: number;
}

interface LocationLike {
  uri?: string;
  range?: { start: LspPosition; end: LspPosition };
  targetUri?: string;
  targetRange?: { start: LspPosition; end: LspPosition };
  targetSelectionRange?: { start: LspPosition; end: LspPosition };
}

/**
 * One clangd process bound to the open project. The host owns document text and
 * turns clangd's native file URIs back into project-relative locations.
 */
export class ClangdSession {
  private readonly documents = new Map<string, { version: number; uri: string }>();
  private readonly diagnostics = new Map<string, DiagnosticRecord>();
  private readonly now: () => number;
  private ready?: Promise<void>;
  private disposed = false;
  private applying?: unknown[];

  constructor(private readonly options: ClangdSessionOptions) {
    this.now = options.now ?? Date.now;
    options.transport.onNotification((method, params) => this.notification(method, params));
    options.transport.setServerRequestHandler?.((method, params) => {
      // clangd.applyFix/clangd.applyTweak ask the client to apply an edit.
      // Capture it so the renderer can apply it to unsaved buffers.
      if (method !== 'workspace/applyEdit') return null;
      const edit = (params as { edit?: unknown } | undefined)?.edit;
      if (!this.applying || !edit) return { applied: false };
      this.applying.push(edit);
      return { applied: true };
    });
  }

  private async doInitialize(): Promise<void> {
    const rootUri = pathToFileURL(this.options.root).href;
    await this.options.transport.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Blode Studio' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false },
            completion: {
              contextSupport: true,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: false,
                documentationFormat: ['markdown', 'plaintext'],
                deprecatedSupport: false,
                preselectSupport: false,
                insertReplaceSupport: false,
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            formatting: { dynamicRegistration: false },
            rangeFormatting: { dynamicRegistration: false },
            codeAction: {
              dynamicRegistration: false,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    '',
                    'quickfix',
                    'refactor',
                    'refactor.extract',
                    'refactor.inline',
                    'refactor.rewrite',
                    'source',
                    'source.fixAll',
                  ],
                },
              },
              isPreferredSupport: true,
              disabledSupport: true,
              dataSupport: true,
            },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
          },
          workspace: {
            workspaceFolders: true,
            configuration: false,
            symbol: { symbolKind: { valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 22, 23] } },
          },
          window: { workDoneProgress: false },
        },
        initializationOptions: { fallbackFlags: this.options.fallbackFlags },
      },
      120_000,
    );
    this.options.transport.notify('initialized', {});
  }

  initialize(): Promise<void> {
    this.ready ??= this.doInitialize();
    return this.ready;
  }

  private absolute(relative: string): string {
    const file = path.resolve(this.options.root, relative);
    const boundary = path.resolve(this.options.root) + path.sep;
    if (!file.startsWith(boundary)) throw new Error('error.invalidPath');
    return file;
  }

  private uri(relative: string): string {
    return pathToFileURL(this.absolute(relative)).href;
  }

  private relative(uri: string): string | undefined {
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const relative = path.relative(this.options.root, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      return undefined;
    return relative.split(path.sep).join('/');
  }

  private languageId(relative: string): string {
    return /\.c$/i.test(relative) ? 'c' : 'cpp';
  }

  private notification(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return;
    const value = params as LspPublishDiagnosticsParams | undefined;
    if (!value || typeof value.uri !== 'string' || !Array.isArray(value.diagnostics)) return;
    const relative = this.relative(value.uri);
    if (!relative) return;
    this.diagnostics.set(relative, {
      items: value.diagnostics.filter(
        (item) =>
          item &&
          typeof item.message === 'string' &&
          item.range?.start &&
          item.range?.end &&
          Number.isInteger(item.range.start.line) &&
          Number.isInteger(item.range.start.character) &&
          !IGNORED_DIAGNOSTIC_CODES.has(String(item.code)),
      ),
      version: value.version,
      receivedAt: this.now(),
    });
    while (this.diagnostics.size > 256) this.diagnostics.delete(this.diagnostics.keys().next().value!);
  }

  didOpen(relative: string, text: string, version: number): void {
    const uri = this.uri(relative);
    this.documents.set(relative, { version, uri });
    this.options.transport.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: this.languageId(relative), version, text },
    });
  }
  didChange(relative: string, text: string, version: number): void {
    const uri = this.documents.get(relative)?.uri ?? this.uri(relative);
    this.documents.set(relative, { version, uri });
    this.options.transport.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }
  didClose(relative: string): void {
    const document = this.documents.get(relative);
    if (!document) return;
    this.documents.delete(relative);
    this.diagnostics.delete(relative);
    this.options.transport.notify('textDocument/didClose', {
      textDocument: { uri: document.uri },
    });
  }

  private position(relative: string, position: LspPosition) {
    return {
      textDocument: { uri: this.uri(relative) },
      position: { line: position.line, character: position.character },
    };
  }

  async completion(relative: string, position: LspPosition): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('textDocument/completion', {
      ...this.position(relative, position),
      context: { triggerKind: 1 },
    });
  }
  async hover(relative: string, position: LspPosition): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('textDocument/hover', this.position(relative, position));
  }
  async definition(relative: string, position: LspPosition): Promise<SourceLocation[]> {
    await this.initialize();
    const result = await this.options.transport.request(
      'textDocument/definition',
      this.position(relative, position),
    );
    return this.locations(result);
  }
  async references(relative: string, position: LspPosition): Promise<SourceLocation[]> {
    await this.initialize();
    const result = await this.options.transport.request('textDocument/references', {
      ...this.position(relative, position),
      context: { includeDeclaration: true },
    });
    return this.locations(result);
  }

  private locations(result: unknown): SourceLocation[] {
    const items = (Array.isArray(result) ? result : result ? [result] : []) as LocationLike[];
    const locations: SourceLocation[] = [];
    for (const item of items.slice(0, MAX_LOCATIONS)) {
      const uri = item.targetUri ?? item.uri;
      const range = item.targetSelectionRange ?? item.targetRange ?? item.range;
      if (!uri || !range?.start || !range?.end) continue;
      const relative = this.relative(uri);
      if (!relative) continue;
      locations.push({
        path: relative,
        line: range.start.line + 1,
        column: range.start.character + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.character + 1,
      });
    }
    return locations;
  }

  diagnosticsFor(relative: string): { items: LspDiagnostic[]; version?: number } {
    const record = this.diagnostics.get(relative);
    return record ? { items: record.items, version: record.version } : { items: [] };
  }

  async formatting(relative: string, options: unknown): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('textDocument/formatting', {
      textDocument: { uri: this.uri(relative) },
      options: options ?? { tabSize: 2, insertSpaces: true },
    });
  }
  async rangeFormatting(relative: string, range: unknown, options: unknown): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('textDocument/rangeFormatting', {
      textDocument: { uri: this.uri(relative) },
      range,
      options: options ?? { tabSize: 2, insertSpaces: true },
    });
  }
  async codeActions(relative: string, range: unknown, context: unknown): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('textDocument/codeAction', {
      textDocument: { uri: this.uri(relative) },
      range,
      context,
    });
  }
  async resolveCodeAction(action: unknown): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('codeAction/resolve', action);
  }
  async executeCommand(command: string, args: unknown[] | undefined): Promise<unknown[]> {
    await this.initialize();
    const collected: unknown[] = [];
    this.applying = collected;
    try {
      const result = await this.options.transport.request('workspace/executeCommand', {
        command,
        ...(args ? { arguments: args } : {}),
      });
      if (result && typeof result === 'object') collected.push(result);
      return collected;
    } finally {
      this.applying = undefined;
    }
  }
  async workspaceSymbols(query: string): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('workspace/symbol', { query });
  }
  async documentSymbols(relative: string): Promise<unknown> {
    await this.initialize();
    return this.options.transport.request('textDocument/documentSymbol', {
      textDocument: { uri: this.uri(relative) },
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.options.transport.request('shutdown', null, 2_000);
    } catch {
      /* A crashed or unresponsive process is killed below. */
    }
    this.options.transport.dispose();
  }
}
