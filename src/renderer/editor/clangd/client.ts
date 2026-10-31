import type * as Monaco from 'monaco-editor';
import type { ClangdState } from '../../../shared/clangd';
import type {
  LspCodeAction,
  LspCommand,
  LspCompletionList,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspTextEdit,
  LspWorkspaceFileEdit,
  LspWorkspaceSymbol,
} from '../../../shared/lsp';
import type { SourceLocation } from '../../../shared/language';
import { lspUriForWorkspacePath } from '../../../shared/lsp';
import { oversizedDocument, WorkspaceDocumentSync } from '../workspaceDocumentSync';
import { toMonacoCompletionItem, toMonacoHover } from '../lspConvert';
import { markersToDiagnostics } from './convert';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

/** Monaco adapter for the host-managed clangd process. Unavailable means "use the fallback". */
export class ClangdClient {
  private readonly sync: WorkspaceDocumentSync;
  private stateCache?: { expires: number; value: ClangdState | undefined };
  private pendingState?: Promise<ClangdState | undefined>;

  constructor(
    private readonly options: {
      projectRoot: () => string;
      resolvePath: (uriPath: string) => string;
    },
  ) {
    this.sync = new WorkspaceDocumentSync({
      projectRoot: options.projectRoot,
      resolvePath: options.resolvePath,
      notify: async (batch) => {
        const api = this.bridge();
        if (api) await api.languageClangdNotify(batch);
      },
    });
  }

  private bridge() {
    if (typeof window === 'undefined') return undefined;
    const bridge = window.blode;
    return typeof bridge?.languageClangdState === 'function' ? bridge : undefined;
  }

  reset(): void {
    this.sync.reset();
    this.stateCache = undefined;
  }

  async state(force = false): Promise<ClangdState | undefined> {
    const api = this.bridge();
    if (!api) return undefined;
    if (!force && this.stateCache && this.stateCache.expires > Date.now()) return this.stateCache.value;
    this.pendingState ??= api
      .languageClangdState()
      .then((state) => state)
      .catch(() => undefined)
      .finally(() => {
        this.pendingState = undefined;
      });
    const value = await this.pendingState;
    this.stateCache = { expires: Date.now() + 10_000, value };
    return value;
  }

  async available(): Promise<boolean> {
    return !!(await this.state())?.available;
  }

  async completion(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    position: Monaco.IPosition,
  ): Promise<Monaco.languages.CompletionItem[] | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
    } catch {
      return undefined;
    }
    if (root !== this.options.projectRoot()) return undefined;
    const word = model.getWordUntilPosition(position);
    const fallbackRange = new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    );
    let result: LspCompletionList | null;
    try {
      result = (await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'textDocument/completion',
        params: {
          textDocument: { uri: lspUriForWorkspacePath(path) },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        },
      })) as LspCompletionList | null;
    } catch {
      return undefined;
    }
    if (!result || !Array.isArray(result.items)) return undefined;
    return result.items.map((item) => toMonacoCompletionItem(monaco, item, fallbackRange));
  }

  async hover(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    position: Monaco.IPosition,
  ): Promise<Monaco.languages.Hover | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
    } catch {
      return undefined;
    }
    if (root !== this.options.projectRoot()) return undefined;
    let result: LspHover | null;
    try {
      result = (await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'textDocument/hover',
        params: {
          textDocument: { uri: lspUriForWorkspacePath(path) },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        },
      })) as LspHover | null;
    } catch {
      return undefined;
    }
    return toMonacoHover(monaco, result);
  }

  async definition(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    position: Monaco.IPosition,
  ): Promise<SourceLocation[] | undefined> {
    return this.locations(monaco, path, model, position, 'textDocument/definition');
  }

  async references(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    position: Monaco.IPosition,
  ): Promise<SourceLocation[] | undefined> {
    return this.locations(monaco, path, model, position, 'textDocument/references');
  }

  private async locations(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    position: Monaco.IPosition,
    method: 'textDocument/definition' | 'textDocument/references',
  ): Promise<SourceLocation[] | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
    } catch {
      return undefined;
    }
    if (root !== this.options.projectRoot()) return undefined;
    try {
      return (await api.languageClangdRequest({
        expectedProjectRoot: root,
        method,
        params: {
          textDocument: { uri: lspUriForWorkspacePath(path) },
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        },
      })) as SourceLocation[];
    } catch {
      return undefined;
    }
  }

  async diagnostics(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
  ): Promise<LspDiagnostic[] | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
      const result = (await api.languageClangdDiagnostics({
        expectedProjectRoot: root,
        path,
      })) as { items?: LspDiagnostic[] } | null;
      return Array.isArray(result?.items) ? result.items : [];
    } catch {
      return undefined;
    }
  }

  async formatting(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    options: { tabSize: number; insertSpaces: boolean },
  ): Promise<LspTextEdit[] | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
      const result = await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'textDocument/formatting',
        params: { textDocument: { uri: lspUriForWorkspacePath(path) }, options },
      });
      return Array.isArray(result) ? (result as LspTextEdit[]) : undefined;
    } catch {
      return undefined;
    }
  }

  async rangeFormatting(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    range: Monaco.IRange,
    options: { tabSize: number; insertSpaces: boolean },
  ): Promise<LspTextEdit[] | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
      const result = await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'textDocument/rangeFormatting',
        params: {
          textDocument: { uri: lspUriForWorkspacePath(path) },
          range: lspRange(range),
          options,
        },
      });
      return Array.isArray(result) ? (result as LspTextEdit[]) : undefined;
    } catch {
      return undefined;
    }
  }

  async codeActions(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    range: Monaco.IRange,
    markers: Monaco.editor.IMarkerData[],
    only?: string[],
  ): Promise<LspCodeAction[] | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
      const result = await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'textDocument/codeAction',
        params: {
          textDocument: { uri: lspUriForWorkspacePath(path) },
          range: lspRange(range),
          context: {
            diagnostics: markersToDiagnostics(markers),
            ...(only?.length ? { only } : {}),
            triggerKind: 1,
          },
        },
      });
      return Array.isArray(result) ? (result as LspCodeAction[]) : undefined;
    } catch {
      return undefined;
    }
  }

  async executeCommand(command: LspCommand): Promise<LspWorkspaceFileEdit[] | undefined> {
    if (!(await this.available())) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      const result = await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'workspace/executeCommand',
        params: {
          command: command.command,
          ...(command.arguments ? { arguments: command.arguments } : {}),
        },
      });
      return Array.isArray(result) ? (result as LspWorkspaceFileEdit[]) : [];
    } catch {
      return undefined;
    }
  }

  async workspaceSymbols(query: string): Promise<LspWorkspaceSymbol[] | undefined> {
    if (!(await this.available())) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      const result = await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'workspace/symbol',
        params: { query },
      });
      return Array.isArray(result) ? (result as LspWorkspaceSymbol[]) : undefined;
    } catch {
      return undefined;
    }
  }

  async documentSymbols(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
  ): Promise<LspDocumentSymbol[] | undefined> {
    if (!(await this.available()) || !path || oversizedDocument(model)) return undefined;
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root) return undefined;
    try {
      await this.sync.sync(monaco, path, model);
      const result = await api.languageClangdRequest({
        expectedProjectRoot: root,
        method: 'textDocument/documentSymbol',
        params: { textDocument: { uri: lspUriForWorkspacePath(path) } },
      });
      return Array.isArray(result) ? (result as LspDocumentSymbol[]) : undefined;
    } catch {
      return undefined;
    }
  }
}

function lspRange(range: Monaco.IRange) {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}
