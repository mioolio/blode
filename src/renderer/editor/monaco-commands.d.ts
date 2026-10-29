declare module 'monaco-editor/esm/vs/editor/browser/editorExtensions.js' {
  interface UndoCommand {
    addImplementation(
      priority: number,
      name: string,
      implementation: () => Promise<void> | false,
    ): { dispose(): void };
  }
  export const UndoCommand: UndoCommand;
  export const RedoCommand: UndoCommand;
}
