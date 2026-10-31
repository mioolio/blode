import type {
  LspDiagnostic,
  LspDidChangeTextDocumentParams,
  LspDidCloseTextDocumentParams,
  LspDidOpenTextDocumentParams,
} from './lsp';

/** Pinned standalone clangd release; keep in sync with core/clangd/manifest.ts. */
export const CLANGD_VERSION = '23.1.0';

export const CLANGD_SOURCES = ['custom', 'bundled', 'managed', 'path'] as const;
export type ClangdSource = (typeof CLANGD_SOURCES)[number];

export interface ClangdState {
  available: boolean;
  source: ClangdSource | null;
  /** Native executable path on the host that runs the service. */
  path?: string;
  version?: string;
  expectedVersion: string;
  installable: boolean;
  hostSupported: boolean;
}

export const CLANGD_REQUEST_METHODS = [
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/references',
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'textDocument/codeAction',
  'textDocument/documentSymbol',
  'workspace/executeCommand',
  'workspace/symbol',
] as const;
export type ClangdRequestMethod = (typeof CLANGD_REQUEST_METHODS)[number];

export const CLANGD_NOTIFICATION_METHODS = [
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
] as const;
export type ClangdNotificationMethod = (typeof CLANGD_NOTIFICATION_METHODS)[number];

export interface ClangdRequestMessage {
  expectedProjectRoot: string;
  method: ClangdRequestMethod;
  params?: unknown;
}
export interface ClangdNotificationMessage {
  method: ClangdNotificationMethod;
  params: unknown;
}
export interface ClangdNotificationBatch {
  expectedProjectRoot: string;
  messages: ClangdNotificationMessage[];
}
export interface ClangdDiagnosticsRequest {
  expectedProjectRoot: string;
  path: string;
}

export type ClangdNotificationParams =
  LspDidOpenTextDocumentParams | LspDidChangeTextDocumentParams | LspDidCloseTextDocumentParams;

export interface ClangdApi {
  languageClangdState(): Promise<ClangdState>;
  languageClangdRequest(request: ClangdRequestMessage): Promise<unknown>;
  languageClangdNotify(request: ClangdNotificationBatch): Promise<void>;
  /** Latest cached `textDocument/publishDiagnostics` for one workspace file. */
  languageClangdDiagnostics(request: ClangdDiagnosticsRequest): Promise<{
    items: LspDiagnostic[];
    version?: number;
  }>;
}
