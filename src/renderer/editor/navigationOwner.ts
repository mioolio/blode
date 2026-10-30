/** Peek editors carry their owner explicitly, even after another split pane receives focus. */
export function ownsEditorNavigation(
  source: object,
  owner: object,
  mounted: { has(editor: object): boolean },
): boolean {
  const visited = new Set<object>();
  let editor: object | null = source;
  while (editor && !visited.has(editor)) {
    if (mounted.has(editor)) return editor === owner;
    visited.add(editor);
    const parent: (() => object | null) | undefined = (editor as { getParentEditor?: () => object | null })
      .getParentEditor;
    if (typeof parent !== 'function') return false;
    try {
      editor = parent.call(editor);
    } catch {
      return false;
    }
  }
  return false;
}
