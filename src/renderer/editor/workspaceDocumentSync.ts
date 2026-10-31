import type * as Monaco from 'monaco-editor';
import type { LspNotificationBatch, LspNotificationMessage } from '../../shared/lsp';
import { lspUriForWorkspacePath } from '../../shared/lsp';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

const MAX_SYNC_MODELS = 24;
const MAX_DOCUMENT_CHARS = 1_000_000;
/** Keep one notification batch below the Web host's 2 MB request limit. */
const MAX_BATCH_CHARS = 1_500_000;

function documentLength(model: Monaco.editor.ITextModel): number {
  const withLength = model as Monaco.editor.ITextModel & { getValueLength?: () => number };
  try {
    return withLength.getValueLength?.() ?? model.getValue().length;
  } catch {
    return 0;
  }
}

/** Size guard shared by language-service clients before sending document text. */
export function oversizedDocument(model: Monaco.editor.ITextModel): boolean {
  return documentLength(model) > MAX_DOCUMENT_CHARS;
}

/**
 * Version-ordered full-document sync for host language services. Unchanged
 * models are skipped and batches are serialised so didChange versions never
 * arrive out of order.
 */
export class WorkspaceDocumentSync {
  private documents = new Map<string, { version: number }>();
  private root = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      projectRoot: () => string;
      resolvePath: (uriPath: string) => string;
      notify: (batch: LspNotificationBatch) => Promise<void>;
    },
  ) {}

  reset(): void {
    this.documents.clear();
    this.root = '';
  }

  sync(monaco: MonacoApi, targetPath: string, targetModel: Monaco.editor.ITextModel): Promise<void> {
    const run = this.queue.then(() => this.performSync(monaco, targetPath, targetModel));
    this.queue = run.catch(() => {});
    return run;
  }

  private async performSync(
    monaco: MonacoApi,
    targetPath: string,
    targetModel: Monaco.editor.ITextModel,
  ): Promise<void> {
    const root = this.options.projectRoot();
    if (!root) return;
    if (root !== this.root) {
      this.root = root;
      this.documents.clear();
    }
    const models = new Map<string, Monaco.editor.ITextModel>();
    if (targetPath) models.set(targetPath, targetModel);
    for (const model of monaco.editor.getModels?.() ?? []) {
      if (models.size >= MAX_SYNC_MODELS) break;
      const path = this.options.resolvePath(model.uri.path);
      if (!path || models.has(path)) continue;
      models.set(path, model);
    }
    const messages: LspNotificationMessage[] = [];
    const changed = new Map<string, { version: number }>();
    let total = 0;
    for (const [path, model] of models) {
      const version = model.getVersionId?.() ?? 0;
      if (this.documents.get(path)?.version === version) continue;
      let text: string;
      try {
        text = model.getValue();
      } catch {
        continue;
      }
      if (text.length > MAX_DOCUMENT_CHARS || total + text.length > MAX_BATCH_CHARS) continue;
      total += text.length;
      let uri: string;
      try {
        uri = lspUriForWorkspacePath(path);
      } catch {
        continue;
      }
      const previous = this.documents.get(path);
      const languageId = model.getLanguageId?.() === 'c' ? 'c' : 'cpp';
      messages.push(
        previous
          ? {
              method: 'textDocument/didChange',
              params: { textDocument: { uri, version }, contentChanges: [{ text }] },
            }
          : {
              method: 'textDocument/didOpen',
              params: { textDocument: { uri, languageId, version, text } },
            },
      );
      changed.set(path, { version });
    }
    if (!messages.length) return;
    await this.options.notify({ expectedProjectRoot: root, messages });
    for (const [path, record] of changed) this.documents.set(path, record);
  }
}
