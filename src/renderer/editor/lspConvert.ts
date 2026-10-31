import type * as Monaco from 'monaco-editor';
import type { LspCompletionItem, LspDiagnostic, LspHover, LspRange } from '../../shared/lsp';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

export function monacoRange(monaco: MonacoApi, range: LspRange): Monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}

export function completionKind(
  monaco: MonacoApi,
  kind: number | undefined,
): Monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 2:
      return kinds.Method;
    case 3:
      return kinds.Function;
    case 4:
      return kinds.Constructor;
    case 5:
      return kinds.Field;
    case 6:
      return kinds.Variable;
    case 7:
      return kinds.Class;
    case 8:
      return kinds.Interface;
    case 9:
      return kinds.Module;
    case 10:
      return kinds.Property;
    case 13:
      return kinds.Enum;
    case 14:
      return kinds.Keyword;
    case 15:
      return kinds.Snippet;
    case 19:
      return kinds.Folder;
    case 20:
      return kinds.EnumMember;
    case 21:
      return kinds.Constant;
    case 22:
      return kinds.Struct;
    case 23:
      return kinds.Event;
    case 24:
      return kinds.Operator;
    case 25:
      return kinds.TypeParameter;
    default:
      return kinds.Text;
  }
}

/** One conversion for the built-in host service and clangd completion results. */
export function toMonacoCompletionItem(
  monaco: MonacoApi,
  item: LspCompletionItem,
  fallbackRange: Monaco.Range,
): Monaco.languages.CompletionItem {
  const label = typeof item.label === 'string' ? item.label : String(item.label);
  const textEdit = (
    item as LspCompletionItem & {
      textEdit?: { range?: LspRange; newText?: string };
    }
  ).textEdit;
  const range = textEdit?.range
    ? monacoRange(monaco, textEdit.range)
    : item.range
      ? monacoRange(monaco, item.range)
      : fallbackRange;
  const insertText = textEdit?.newText ?? item.insertText ?? label;
  const documentation =
    typeof item.documentation === 'string'
      ? item.documentation
      : item.documentation
        ? { value: item.documentation.value }
        : undefined;
  return {
    label: label.replace(/^\s+/, ''),
    kind: completionKind(monaco, item.kind),
    detail: item.detail,
    ...(documentation ? { documentation } : {}),
    insertText,
    insertTextRules:
      item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    sortText: item.sortText ?? label,
    ...(item.filterText ? { filterText: item.filterText } : {}),
    range,
  };
}

export function toMonacoHover(
  monaco: MonacoApi,
  hover: LspHover | null | undefined,
): Monaco.languages.Hover | undefined {
  const contents = hover?.contents;
  if (!contents) return undefined;
  const value =
    typeof contents === 'string'
      ? contents
      : Array.isArray(contents)
        ? contents
            .map((entry) => (typeof entry === 'string' ? entry : entry.value))
            .filter(Boolean)
            .join('\n\n')
        : contents.value;
  if (!value) return undefined;
  return {
    contents: [{ value }],
    ...(hover?.range ? { range: monacoRange(monaco, hover.range) } : {}),
  };
}

export function markerSeverity(monaco: MonacoApi, severity: number | undefined): Monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

export function toMonacoMarker(monaco: MonacoApi, diagnostic: LspDiagnostic): Monaco.editor.IMarkerData {
  const startLine = Math.max(1, diagnostic.range.start.line + 1);
  const startColumn = Math.max(1, diagnostic.range.start.character + 1);
  const endLine = Math.max(startLine, diagnostic.range.end.line + 1);
  const endColumn = Math.max(endLine === startLine ? startColumn + 1 : 1, diagnostic.range.end.character + 1);
  return {
    severity: markerSeverity(monaco, diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? 'clangd',
    ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
    startLineNumber: startLine,
    startColumn,
    endLineNumber: endLine,
    endColumn,
  };
}
