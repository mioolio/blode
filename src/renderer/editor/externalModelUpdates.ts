import type * as Monaco from 'monaco-editor';

const refreshing = new WeakSet<Monaco.editor.ITextModel>();
export const externalModelIsRefreshing = (model: Monaco.editor.ITextModel) => refreshing.has(model);

/** SDK refreshes replace a read-only snapshot and reset Monaco's native undo stack. */
export function refreshExternalModel(model: Monaco.editor.ITextModel, content: string): void {
  if (model.isDisposed() || model.getValue() === content) return;
  refreshing.add(model);
  try {
    model.setValue(content);
  } finally {
    refreshing.delete(model);
  }
}
