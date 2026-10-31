import type * as Monaco from 'monaco-editor';
import type { LspCommand } from '../../../shared/lsp';
import type { ClangdClient } from './client';
import {
  applyWorkspaceEdits,
  CLANGD_COMMAND_ID,
  toMonacoCodeAction,
  toMonacoDocumentSymbols,
  toMonacoTextEdits,
} from './convert';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');
type RangeFormattingProvider = Monaco.languages.DocumentRangeFormattingEditProvider;

const CODE_ACTION_KINDS = ['quickfix', 'refactor', 'refactor.extract', 'refactor.rewrite', 'source.fixAll'];

/**
 * Editor features that do not participate in the completion/hover pipeline:
 * formatting, quick fixes/tweaks and document symbols. Workspace symbol search
 * uses the same client from its own picker.
 */
export function registerClangdEditorFeatures(
  monaco: MonacoApi,
  client: ClangdClient,
  options: {
    root: () => string;
    resolvePath: (uriPath: string) => string;
  },
  disposables: Monaco.IDisposable[],
): void {
  const editor = monaco.editor as typeof monaco.editor & {
    registerCommand?: (
      id: string,
      handler: (accessor: unknown, ...args: any[]) => void,
    ) => Monaco.IDisposable;
  };
  if (typeof editor.registerCommand === 'function')
    disposables.push(
      editor.registerCommand(CLANGD_COMMAND_ID, (_accessor, action: LspCommand) => {
        void (async () => {
          const root = options.root();
          if (!root || !action?.command) return;
          const edits = await client.executeCommand(action);
          if (edits?.length) applyWorkspaceEdits(monaco, root, edits);
        })();
      }),
    );

  const languages = monaco.languages as typeof monaco.languages & {
    registerDocumentRangeFormattingEditProvider?: (
      language: string,
      provider: RangeFormattingProvider,
    ) => Monaco.IDisposable;
  };

  for (const language of ['cpp', 'c']) {
    if (typeof monaco.languages.registerDocumentFormattingEditProvider === 'function')
      disposables.push(
        monaco.languages.registerDocumentFormattingEditProvider(language, {
          async provideDocumentFormattingEdits(model, formattingOptions) {
            const path = options.resolvePath(model.uri.path);
            if (!path) return undefined;
            const edits = await client.formatting(monaco, path, model, {
              tabSize: formattingOptions.tabSize,
              insertSpaces: formattingOptions.insertSpaces,
            });
            return edits ? toMonacoTextEdits(monaco, edits) : undefined;
          },
        }),
      );

    if (typeof languages.registerDocumentRangeFormattingEditProvider === 'function')
      disposables.push(
        languages.registerDocumentRangeFormattingEditProvider(language, {
          async provideDocumentRangeFormattingEdits(model, range, formattingOptions) {
            const path = options.resolvePath(model.uri.path);
            if (!path) return undefined;
            const edits = await client.rangeFormatting(monaco, path, model, range, {
              tabSize: formattingOptions.tabSize,
              insertSpaces: formattingOptions.insertSpaces,
            });
            return edits ? toMonacoTextEdits(monaco, edits) : undefined;
          },
        }),
      );

    if (typeof monaco.languages.registerCodeActionProvider === 'function')
      disposables.push(
        monaco.languages.registerCodeActionProvider(
          language,
          {
            async provideCodeActions(model, range, context) {
              const path = options.resolvePath(model.uri.path);
              const root = options.root();
              if (!path || !root) return { actions: [], dispose() {} };
              const actions = await client.codeActions(
                monaco,
                path,
                model,
                range,
                context.markers ?? [],
                context.only ? [context.only] : undefined,
              );
              return {
                actions: (actions ?? []).map((action) => toMonacoCodeAction(monaco, root, action)),
                dispose() {},
              };
            },
          },
          { providedCodeActionKinds: CODE_ACTION_KINDS },
        ),
      );

    if (typeof monaco.languages.registerDocumentSymbolProvider === 'function')
      disposables.push(
        monaco.languages.registerDocumentSymbolProvider(language, {
          displayName: 'clangd',
          async provideDocumentSymbols(model) {
            const path = options.resolvePath(model.uri.path);
            if (!path) return undefined;
            const symbols = await client.documentSymbols(monaco, path, model);
            return symbols ? toMonacoDocumentSymbols(monaco, symbols) : undefined;
          },
        }),
      );
  }
}
