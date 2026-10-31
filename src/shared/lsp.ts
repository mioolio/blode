import { normalizeSourcePath } from './language-index';

/**
 * The host language service speaks a small, explicit LSP 3.17 subset over the
 * existing workbench transport. Documents are addressed with a workspace URI so
 * no native path, drive letter or host URL ever crosses the renderer boundary.
 */
export const LSP_WORKSPACE_URI_PREFIX = 'blode://workspace/';

export interface LspPosition {
  /** Zero-based UTF-16 line index. */
  line: number;
  /** Zero-based UTF-16 offset inside the line. */
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspTextDocumentIdentifier {
  uri: string;
}
export interface LspVersionedTextDocumentIdentifier extends LspTextDocumentIdentifier {
  version: number;
}
export interface LspTextDocumentItem extends LspTextDocumentIdentifier {
  languageId: string;
  version: number;
  text: string;
}
export interface LspTextDocumentPositionParams {
  textDocument: LspTextDocumentIdentifier;
  position: LspPosition;
}
export interface LspMarkupContent {
  kind: 'markdown' | 'plaintext';
  value: string;
}
export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  range?: LspRange;
}
export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}
export interface LspHover {
  contents: LspMarkupContent;
  range?: LspRange;
}
/** The subset of LSP diagnostics that the editor renders as Monaco markers. */
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
export interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
  version?: number;
}
export interface LspDiagnosticReport {
  kind: 'full' | 'unchanged';
  items: LspDiagnostic[];
  version?: number;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
/** Workspace edit entries are already scoped to project-relative files. */
export interface LspWorkspaceFileEdit {
  path: string;
  edits: LspTextEdit[];
}
export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}
export interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: LspDiagnostic[];
  edit?: LspWorkspaceFileEdit[];
  command?: LspCommand;
}
export interface LspWorkspaceSymbol {
  name: string;
  kind?: number;
  containerName?: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind?: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
export interface LspServerCapabilities {
  positionEncoding?: 'utf-16';
  textDocumentSync?: { openClose: boolean; change: number };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider: boolean };
  hoverProvider?: boolean;
}
export interface LspInitializeResult {
  serverInfo: { name: string; version?: string };
  capabilities: LspServerCapabilities;
}
export type LspResponse = LspInitializeResult | LspCompletionList | LspHover | null;
export interface LspTextDocumentContentChangeEvent {
  /** Full-document sync: the complete text after the change. */
  text: string;
}
export interface LspDidOpenTextDocumentParams {
  textDocument: LspTextDocumentItem;
}
export interface LspDidChangeTextDocumentParams {
  textDocument: LspVersionedTextDocumentIdentifier;
  contentChanges: LspTextDocumentContentChangeEvent[];
}
export interface LspDidCloseTextDocumentParams {
  textDocument: LspTextDocumentIdentifier;
}

export const LSP_REQUEST_METHODS = [
  'initialize',
  'shutdown',
  'textDocument/completion',
  'textDocument/hover',
] as const;
export type LspRequestMethod = (typeof LSP_REQUEST_METHODS)[number];

export const LSP_NOTIFICATION_METHODS = [
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
] as const;
export type LspNotificationMethod = (typeof LSP_NOTIFICATION_METHODS)[number];

export interface LspRequestMessage {
  expectedProjectRoot: string;
  method: LspRequestMethod;
  params?: unknown;
}
export interface LspNotificationMessage {
  method: LspNotificationMethod;
  params: unknown;
}
/** JSON-RPC batching is reused so a tab switch syncs several documents in one call. */
export interface LspNotificationBatch {
  expectedProjectRoot: string;
  messages: LspNotificationMessage[];
}

export const LSP_INSERT_TEXT_FORMAT = { plainText: 1, snippet: 2 } as const;
export const LSP_TEXT_DOCUMENT_SYNC_KIND = { none: 0, full: 1, incremental: 2 } as const;
/** Completion item kinds from the LSP specification. */
export const LSP_COMPLETION_ITEM_KIND = {
  text: 1,
  method: 2,
  function: 3,
  constructor: 4,
  field: 5,
  variable: 6,
  class: 7,
  interface: 8,
  module: 9,
  property: 10,
  unit: 11,
  value: 12,
  enum: 13,
  keyword: 14,
  snippet: 15,
  color: 16,
  file: 17,
  reference: 18,
  folder: 19,
  enumMember: 20,
  constant: 21,
  struct: 22,
  event: 23,
  operator: 24,
  typeParameter: 25,
} as const;

const segmentIsUnsafe = (segment: string) =>
  !segment || segment === '.' || segment === '..' || /[\\/\0\r\n:]/.test(segment) || segment.length > 255;

/** Encode a project-relative source path as a stable workspace document URI. */
export function lspUriForWorkspacePath(value: string): string {
  const segments = normalizeSourcePath(value)
    .split('/')
    .filter((segment) => segment !== '');
  if (!segments.length || segments.some(segmentIsUnsafe)) throw new Error('error.invalidPath');
  return LSP_WORKSPACE_URI_PREFIX + segments.map(encodeURIComponent).join('/');
}

/** Inverse of `lspUriForWorkspacePath`; rejects foreign schemes and traversal. */
export function workspacePathFromLspUri(uri: string): string | undefined {
  if (!uri.startsWith(LSP_WORKSPACE_URI_PREFIX)) return undefined;
  const encoded = uri.slice(LSP_WORKSPACE_URI_PREFIX.length);
  if (!encoded || encoded.length > 4096) return undefined;
  const segments: string[] = [];
  for (const segment of encoded.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (segmentIsUnsafe(decoded)) return undefined;
    segments.push(decoded);
  }
  return segments.join('/');
}
