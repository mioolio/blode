export interface LanguageSource {
  path: string;
  content: string;
}
export interface SourceLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
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
}
