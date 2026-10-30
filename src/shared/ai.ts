import type { CompletionEntry, LanguageCompletions } from '../../extensions/completions/types';

/** Declarative additions, replacements or suppressions; never executable completion code. */
export interface AiCompletionEntry extends CompletionEntry {
  language: string;
  owner?: string;
  disabled?: boolean;
}
export interface AiAssistanceState {
  revision: number;
  predictionEnabled: boolean;
  predictionDelayMs: number;
  useBuiltins: boolean;
  entries: AiCompletionEntry[];
  builtins: LanguageCompletions[];
}
export interface AiAssistanceConfiguration {
  revision: number;
  predictionEnabled?: boolean;
  predictionDelayMs?: number;
  useBuiltins?: boolean;
  entries?: AiCompletionEntry[];
  resetCatalog?: boolean;
}
export interface AiPredictionContext {
  editorId: string;
  projectRoot: string;
  path: string;
  modelVersion: number;
  line: number;
  column: number;
  prefix: string;
  suffix: string;
  /** A deliberate, single completion action; automatic callers omit this. */
  manual?: boolean;
}
export interface AiPredictionRequest extends AiPredictionContext {
  id: string;
  sequence: number;
  createdAt: string;
  expiresAt: string;
}
export interface AiPredictionSuggestion {
  requestId: string;
  text: string;
  createdAt: string;
}
export interface AiAssistanceApi {
  aiAssistanceState(): Promise<AiAssistanceState>;
  aiAssistanceConfigure(config: AiAssistanceConfiguration): Promise<AiAssistanceState>;
  aiPredictionRequest(context: AiPredictionContext): Promise<AiPredictionRequest | null>;
  aiPredictionCancel(request: { editorId: string; requestId?: string }): Promise<void>;
  aiPredictionPoll(request?: {
    after?: number;
  }): Promise<{ cursor: number; requests: AiPredictionRequest[] }>;
  aiPredictionSubmit(request: { requestId: string; text: string }): Promise<AiPredictionSuggestion>;
  aiPredictionRead(request: { requestId: string }): Promise<AiPredictionSuggestion | null>;
}
