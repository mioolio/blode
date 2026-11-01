import type { SourceLocation } from './language';

/** Build diagnostics travel with logs so desktop and Web replay the same result. */
export interface CompilerDiagnostic {
  projectRoot: string;
  severity: 'warning' | 'error';
  message: string;
  file?: string;
  location?: SourceLocation;
}
