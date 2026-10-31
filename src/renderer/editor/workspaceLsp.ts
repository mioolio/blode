import type * as Monaco from 'monaco-editor';
import { lspUriForWorkspacePath, type LspCompletionList, type LspHover } from '../../shared/lsp';
import { toMonacoCompletionItem, toMonacoHover } from './lspConvert';
import { oversizedDocument, WorkspaceDocumentSync } from './workspaceDocumentSync';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

/**
 * Monaco-side client for the host's built-in workspace language service. It is
 * the offline fallback when clangd is not installed.
 */
export class WorkspaceLspClient {
  private readonly sync: WorkspaceDocumentSync;
  private initialized = new Set<string>();

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
        if (api) await api.languageLspNotify(batch);
      },
    });
  }

  private bridge() {
    if (typeof window === 'undefined') return undefined;
    const bridge = window.blode;
    return typeof bridge?.languageLspRequest === 'function' ? bridge : undefined;
  }

  reset(): void {
    this.sync.reset();
    this.initialized.clear();
  }

  private async ensureInitialized(root: string): Promise<void> {
    if (this.initialized.has(root)) return;
    const api = this.bridge();
    if (!api) return;
    await api.languageLspRequest({
      expectedProjectRoot: root,
      method: 'initialize',
      params: { processId: null, rootUri: null, capabilities: {} },
    });
    this.initialized.add(root);
  }

  async completion(
    monaco: MonacoApi,
    path: string,
    model: Monaco.editor.ITextModel,
    position: Monaco.IPosition,
  ): Promise<Monaco.languages.CompletionItem[] | undefined> {
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root || !path || oversizedDocument(model)) return undefined;
    try {
      await this.ensureInitialized(root);
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
      result = (await api.languageLspRequest({
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
    const api = this.bridge();
    const root = this.options.projectRoot();
    if (!api || !root || !path || oversizedDocument(model)) return undefined;
    try {
      await this.ensureInitialized(root);
      await this.sync.sync(monaco, path, model);
    } catch {
      return undefined;
    }
    if (root !== this.options.projectRoot()) return undefined;
    let result: LspHover | null;
    try {
      result = (await api.languageLspRequest({
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
}
