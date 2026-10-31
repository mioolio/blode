import type * as Monaco from 'monaco-editor';
import { setEditorProblems, type EditorProblem } from '../workspace/editorProblems';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');
const MAX_PROBLEMS = 500;

/**
 * Mirror Monaco markers into the workspace Problems surface. Without this the
 * status bar only counted log events and could show 0 while clangd underlined
 * real errors.
 */
export function attachEditorProblems(
  monaco: MonacoApi,
  resolvePath: (uriPath: string) => string,
  disposables: Monaco.IDisposable[],
): void {
  const collect = () => {
    const issues: EditorProblem[] = [];
    for (const model of monaco.editor.getModels?.() ?? []) {
      if (issues.length >= MAX_PROBLEMS) break;
      const path = resolvePath(model.uri.path);
      if (!path) continue;
      const markers = monaco.editor.getModelMarkers?.({ resource: model.uri }) ?? [];
      for (const marker of markers) {
        if (issues.length >= MAX_PROBLEMS) break;
        if (marker.severity !== 8 && marker.severity !== 4) continue;
        issues.push({
          path,
          line: marker.startLineNumber,
          column: marker.startColumn,
          endLine: marker.endLineNumber,
          endColumn: marker.endColumn,
          severity: marker.severity === 8 ? 'error' : 'warning',
          message: marker.message,
          ...(marker.source ? { source: marker.source } : {}),
        });
      }
    }
    setEditorProblems(issues);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(collect, 120);
  };
  if (typeof monaco.editor.onDidChangeMarkers === 'function')
    disposables.push(monaco.editor.onDidChangeMarkers(schedule));
  if (typeof monaco.editor.onDidCreateModel === 'function')
    disposables.push(monaco.editor.onDidCreateModel(schedule));
  disposables.push({
    dispose() {
      clearTimeout(timer);
    },
  });
  schedule();
}
