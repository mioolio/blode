import type * as Monaco from 'monaco-editor';
import type {
  LspCodeAction,
  LspCommand,
  LspDocumentSymbol,
  LspTextEdit,
  LspWorkspaceFileEdit,
  LspDiagnostic,
} from '../../../shared/lsp';
import { monacoRange, toMonacoMarker } from '../lspConvert';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

export const CLANGD_COMMAND_ID = 'blode.clangd.execute';

export function toMonacoTextEdits(monaco: MonacoApi, edits: LspTextEdit[]): Monaco.languages.TextEdit[] {
  return edits.map((edit) => ({ range: monacoRange(monaco, edit.range), text: edit.newText }));
}

/** Convert project-relative workspace edits into Monaco's resource-based form. */
export function toMonacoWorkspaceEdit(
  monaco: MonacoApi,
  root: string,
  files: LspWorkspaceFileEdit[],
): Monaco.languages.WorkspaceEdit {
  return {
    edits: files.flatMap((file) =>
      file.edits.map((edit) => ({
        resource: monaco.Uri.file(`${root}/${file.path}`),
        textEdit: { range: monacoRange(monaco, edit.range), text: edit.newText },
        versionId: undefined,
      })),
    ),
  };
}

/** Apply command results manually; Monaco only applies edits returned by providers. */
export function applyWorkspaceEdits(monaco: MonacoApi, root: string, files: LspWorkspaceFileEdit[]): boolean {
  let applied = false;
  for (const file of files) {
    const model = monaco.editor.getModel(monaco.Uri.file(`${root}/${file.path}`));
    if (!model || !file.edits.length) continue;
    const edits = file.edits
      .map((edit) => ({ range: monacoRange(monaco, edit.range), text: edit.newText }))
      .sort(
        (a, b) =>
          model.getOffsetAt(b.range.getStartPosition()) - model.getOffsetAt(a.range.getStartPosition()),
      );
    model.pushEditOperations([], edits, () => null);
    applied = true;
  }
  return applied;
}

export function markersToDiagnostics(markers: Monaco.editor.IMarkerData[]): LspDiagnostic[] {
  return markers.slice(0, 200).map((marker) => ({
    range: {
      start: {
        line: Math.max(0, marker.startLineNumber - 1),
        character: Math.max(0, marker.startColumn - 1),
      },
      end: {
        line: Math.max(0, marker.endLineNumber - 1),
        character: Math.max(0, marker.endColumn - 1),
      },
    },
    severity: marker.severity === 8 ? 1 : marker.severity === 4 ? 2 : marker.severity === 2 ? 3 : 4,
    ...(marker.code !== undefined
      ? {
          code:
            typeof marker.code === 'string' || typeof marker.code === 'number'
              ? marker.code
              : marker.code.value,
        }
      : {}),
    ...(marker.source ? { source: marker.source } : {}),
    message: marker.message,
  }));
}

function symbolKind(monaco: MonacoApi, kind: number | undefined): Monaco.languages.SymbolKind {
  const value = (kind ?? 1) - 1;
  return (value >= 0 && value <= 25 ? value : 0) as Monaco.languages.SymbolKind;
}

function clampRange(
  monaco: MonacoApi,
  symbol: LspDocumentSymbol,
): { range: Monaco.Range; selectionRange: Monaco.Range } {
  const range = monacoRange(monaco, symbol.range);
  const selection = monacoRange(monaco, symbol.selectionRange);
  const contained =
    range.containsPosition(selection.getStartPosition()) &&
    range.containsPosition(selection.getEndPosition());
  return { range, selectionRange: contained ? selection : range };
}

export function toMonacoDocumentSymbols(
  monaco: MonacoApi,
  symbols: LspDocumentSymbol[],
  depth = 0,
): Monaco.languages.DocumentSymbol[] {
  if (depth > 8) return [];
  return symbols.slice(0, 2_000).map((symbol) => {
    const { range, selectionRange } = clampRange(monaco, symbol);
    return {
      name: symbol.name,
      detail: symbol.detail ?? '',
      kind: symbolKind(monaco, symbol.kind),
      tags: [],
      range,
      selectionRange,
      ...(symbol.children?.length
        ? { children: toMonacoDocumentSymbols(monaco, symbol.children, depth + 1) }
        : {}),
    };
  });
}

export function toMonacoCodeAction(
  monaco: MonacoApi,
  root: string,
  action: LspCodeAction,
): Monaco.languages.CodeAction {
  const command: Monaco.languages.Command | undefined = action.command
    ? {
        id: CLANGD_COMMAND_ID,
        title: action.command.title,
        arguments: [action.command],
      }
    : undefined;
  return {
    title: action.title,
    ...(action.kind ? { kind: action.kind } : {}),
    ...(action.isPreferred ? { isPreferred: true } : {}),
    ...(action.diagnostics?.length
      ? { diagnostics: action.diagnostics.map((item) => toMonacoMarker(monaco, item)) }
      : {}),
    ...(action.edit?.length ? { edit: toMonacoWorkspaceEdit(monaco, root, action.edit) } : {}),
    ...(command ? { command } : {}),
  };
}

export type ClangdCommandArgument = LspCommand;
