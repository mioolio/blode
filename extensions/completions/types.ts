/**
 * Declarative language completions. This module is shared data only: it must not
 * import Node, Electron or Monaco so the registry stays inspectable and testable.
 */
export type CompletionKind =
  'function' | 'method' | 'variable' | 'constant' | 'type' | 'keyword' | 'snippet' | 'property';

export interface CompletionEntry {
  /** Text shown and matched in the suggestion list. */
  name: string;
  kind: CompletionKind;
  /** One-line signature or type rendered beside the label. */
  detail: string;
  /** Markdown shown in the expanded suggestion and hover panels. */
  documentation?: string;
  /** Monaco snippet syntax. Defaults to the label when omitted. */
  insertText?: string;
  /** Lower values sort first; the renderer supplies a per-kind default. */
  sortText?: string;
}

/** Members are offered only after `<owner>.` to avoid polluting global suggestions. */
export interface MemberGroup {
  owner: string;
  members: CompletionEntry[];
}

export interface LanguageCompletions {
  /** Monaco language id, for example `cpp`. */
  language: string;
  /** Characters that open the suggestion widget immediately. */
  triggerCharacters?: string[];
  snippets?: CompletionEntry[];
  symbols?: CompletionEntry[];
  members?: MemberGroup[];
}
