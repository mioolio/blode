import { useSyncExternalStore } from 'react';

export type EditorProblemSeverity = 'error' | 'warning';

export interface EditorProblem {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: EditorProblemSeverity;
  message: string;
  source?: string;
}

let snapshot: EditorProblem[] = [];
const listeners = new Set<() => void>();

/** Monaco markers are the source of truth for editor diagnostics; logs are separate. */
export function setEditorProblems(next: EditorProblem[]): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function editorProblemsSnapshot(): EditorProblem[] {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditorProblems(): EditorProblem[] {
  return useSyncExternalStore(subscribe, editorProblemsSnapshot, editorProblemsSnapshot);
}
