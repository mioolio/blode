import type * as Monaco from 'monaco-editor';
import { compilerProblemsSnapshot, subscribeProblems } from '../workspace/editorProblems';
import type { EditorProblem } from '../workspace/editorProblems';
import './compiler-diagnostics.css';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

export function attachCompilerDiagnostics(
  monaco: MonacoApi,
  scope: { root(): string; path(uri: string): string },
  disposables: Monaco.IDisposable[],
) {
  const applied = new Map<Monaco.editor.ITextModel, { signature: string; decorations: string[] }>();
  let lastProblems: EditorProblem[] | undefined,
    lastRoot = '';
  const synchronize = (force = false) => {
    const snapshot = compilerProblemsSnapshot();
    const root = scope.root();
    if (!force && snapshot.problems === lastProblems && root === lastRoot) return;
    lastProblems = snapshot.problems;
    lastRoot = root;
    const byPath = new Map<string, EditorProblem[]>();
    if (snapshot.root === root)
      for (const problem of snapshot.problems) {
        const items = byPath.get(problem.path) ?? [];
        items.push(problem);
        byPath.set(problem.path, items);
      }
    for (const model of monaco.editor.getModels()) {
      if (model.isDisposed()) continue;
      const relative = scope.path(model.uri.path);
      const problems = byPath.get(relative) ?? [];
      const previous = applied.get(model);
      if (!problems.length && !previous) continue;
      const signature = JSON.stringify(problems);
      if (previous?.signature === signature) continue;
      const markers = problems.map((problem) => {
        const line = Math.max(1, Math.min(problem.line, model.getLineCount()));
        const column = Math.max(1, Math.min(problem.column, model.getLineMaxColumn(line)));
        return {
          startLineNumber: line,
          startColumn: column,
          endLineNumber: line,
          endColumn: Math.min(model.getLineMaxColumn(line), Math.max(column + 1, problem.endColumn)),
          severity:
            problem.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: problem.message,
          source: 'compiler',
        };
      });
      monaco.editor.setModelMarkers(model, 'blode-compiler', markers);
      const decorations = model.deltaDecorations(
        previous?.decorations ?? [],
        markers.map((marker) => {
          const warning = marker.severity === monaco.MarkerSeverity.Warning;
          return {
            range: new monaco.Range(
              marker.startLineNumber,
              marker.startColumn,
              marker.endLineNumber,
              marker.endColumn,
            ),
            options: {
              isWholeLine: true,
              className: warning ? 'compiler-warning-line' : 'compiler-error-line',
              linesDecorationsClassName: warning ? 'compiler-warning-gutter' : 'compiler-error-gutter',
              overviewRuler: {
                color: warning ? '#d99a35' : '#e45d63',
                position: monaco.editor.OverviewRulerLane.Right,
              },
            },
          };
        }),
      );
      applied.set(model, { signature, decorations });
    }
    for (const model of applied.keys()) if (model.isDisposed()) applied.delete(model);
  };
  const unsubscribe = subscribeProblems(synchronize);
  disposables.push(monaco.editor.onDidCreateModel(() => synchronize(true)));
  disposables.push({
    dispose() {
      unsubscribe();
      for (const [model, previous] of applied)
        if (!model.isDisposed()) {
          monaco.editor.setModelMarkers(model, 'blode-compiler', []);
          model.deltaDecorations(previous.decorations, []);
        }
      applied.clear();
    },
  });
  synchronize();
}
