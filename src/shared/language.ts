export interface LanguageSource {
  path: string;
  content: string;
}
export interface SourceLocation {
  path: string;
  /** Issued by the host for a read-only source outside the workspace. */
  externalId?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}
export interface LanguageNavigationRequest {
  /** A cancellable, renderer-scoped request identity. */
  requestId?: string;
  expectedProjectRoot: string;
  path: string;
  externalId?: string;
  kind: 'include' | 'definition' | 'declaration' | 'reference';
  symbol?: string;
  specifier?: string;
}
export interface LanguageExternalSource {
  id: string;
  /** A virtual, non-writable tab identity. */
  path: string;
  name: string;
  displayPath: string;
  content: string;
  language: 'cpp';
  readonly: true;
}
export interface LanguageSymbol extends SourceLocation {
  name: string;
  kind: 'function' | 'macro' | 'type' | 'variable' | 'constant';
  signature: string;
  definition: boolean;
  /** Local symbols are offered within their source file. */
  local?: boolean;
}
export interface LanguageInclude extends SourceLocation {
  specifier: string;
  system: boolean;
}
export interface LanguageIndexSnapshot {
  version: 1;
  projectRoot: string;
  fileCount: number;
  symbols: LanguageSymbol[];
  includes: LanguageInclude[];
}
export interface LanguageApi {
  languageIndex(): Promise<LanguageIndexSnapshot>;
  languageNavigate(request: LanguageNavigationRequest): Promise<SourceLocation[]>;
  languageCancel(request: { expectedProjectRoot: string; requestId: string }): Promise<void>;
  languageOpenExternal(request: {
    expectedProjectRoot: string;
    externalId: string;
  }): Promise<LanguageExternalSource>;
}
