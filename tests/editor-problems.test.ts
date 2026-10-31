import test from 'node:test';
import assert from 'node:assert/strict';
import { attachEditorProblems } from '../src/renderer/editor/editorProblems';
import { editorProblemsSnapshot, setEditorProblems } from '../src/renderer/workspace/editorProblems';

test('Monaco markers feed the Problems surface counts', async () => {
  setEditorProblems([]);
  const listeners = new Set<() => void>();
  const monaco = {
    editor: {
      getModels: () => [{ uri: { path: '/workspace/User/main.c' } }],
      getModelMarkers: () => [
        {
          severity: 8,
          message: "'stm32f10x.h' file not found",
          source: 'clang',
          startLineNumber: 1,
          startColumn: 10,
          endLineNumber: 1,
          endColumn: 24,
        },
        {
          severity: 4,
          message: 'unused include',
          source: 'clang',
          startLineNumber: 2,
          startColumn: 10,
          endLineNumber: 2,
          endColumn: 18,
        },
        {
          severity: 2,
          message: 'information marker',
          source: 'clang',
          startLineNumber: 3,
          startColumn: 1,
          endLineNumber: 3,
          endColumn: 2,
        },
      ],
      onDidChangeMarkers: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      onDidCreateModel: () => ({ dispose() {} }),
    },
  } as any;
  const disposables: { dispose(): void }[] = [];
  attachEditorProblems(monaco, (uriPath) => (uriPath.endsWith('main.c') ? 'User/main.c' : ''), disposables);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    editorProblemsSnapshot().map((item) => [item.path, item.line, item.severity, item.message]),
    [
      ['User/main.c', 1, 'error', "'stm32f10x.h' file not found"],
      ['User/main.c', 2, 'warning', 'unused include'],
    ],
  );
  for (const disposable of disposables) disposable.dispose();
  setEditorProblems([]);
});
