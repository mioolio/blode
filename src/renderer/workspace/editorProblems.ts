import { useSyncExternalStore } from 'react';
import type { LogEvent } from '../../shared/contracts';

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
let editorSnapshot: EditorProblem[] = [];
let compilerSnapshot: EditorProblem[] = [];
let compilerRoot = '';
const listeners = new Set<() => void>();

const keyOf = (problem: EditorProblem) =>
  JSON.stringify([problem.path, problem.line, problem.column, problem.severity, problem.message]);
function publish() {
  snapshot = [
    ...new Map([...compilerSnapshot, ...editorSnapshot].map((problem) => [keyOf(problem), problem])).values(),
  ];
  for (const listener of listeners) listener();
}
/** Live editor diagnostics and build results have separate lifetimes. */
export function setEditorProblems(next: EditorProblem[]): void {
  editorSnapshot = next;
  publish();
}

export function setCompilerProblems(root: string, logs: readonly LogEvent[]): void {
  const next = [
    ...new Map(
      logs.flatMap((event) => {
        const diagnostic = event.diagnostic;
        if (!diagnostic?.location || diagnostic.projectRoot !== root) return [];
        const problem = {
          ...diagnostic.location,
          severity: diagnostic.severity,
          message: diagnostic.message,
          source: 'compiler',
        };
        return [[keyOf(problem), problem] as const];
      }),
    ).values(),
  ];
  if (
    compilerRoot === root &&
    next.length === compilerSnapshot.length &&
    next.every((problem, index) => keyOf(problem) === keyOf(compilerSnapshot[index]))
  )
    return;
  if (compilerRoot !== root) editorSnapshot = [];
  compilerRoot = root;
  compilerSnapshot = next;
  publish();
}

export const compilerProblemsSnapshot = () => ({ root: compilerRoot, problems: compilerSnapshot });
export const subscribeProblems = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

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
