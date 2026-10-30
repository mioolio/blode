import type * as Monaco from 'monaco-editor';
import { currentAiContext, openAiAssistant, type AiEditorContext } from '../workspace/aiContext';
import type { AiChatSession } from '../../shared/model-service';

export interface ApplyLocalAiEdit {
  projectRoot: string;
  edit: NonNullable<AiChatSession['pendingEdit']>;
  originalContent: string;
  handled?: boolean;
  validateOnly?: boolean;
  reply(applied: boolean): void;
}
export function attachAiEditorActions(
  monaco: typeof import('monaco-editor/esm/vs/editor/editor.api.js'),
  editor: Monaco.editor.IStandaloneCodeEditor,
  options: { context(): AiEditorContext | undefined; active(): boolean; t(key: string): string },
): Monaco.IDisposable {
  const actions = (['ask', 'edit'] as const).map((intent, index) =>
    editor.addAction({
      id: `blode.ai.${intent}`,
      label: options.t(`ai.chat.${intent}`),
      contextMenuGroupId: '9_blode_ai',
      contextMenuOrder: index + 1,
      ...(intent === 'edit' ? { precondition: '!editorReadonly' } : {}),
      run: () => {
        const context = options.context();
        if (context) openAiAssistant(intent, { ...context, actor: currentAiContext(context)?.actor });
      },
    }),
  );
  const contextRequested = (event: Event) => {
    if (!options.active()) return;
    const context = options.context();
    if (context) (event as CustomEvent<{ reply(context: AiEditorContext): void }>).detail?.reply(context);
  };
  const apply = (event: Event) => {
    const detail = (event as CustomEvent<ApplyLocalAiEdit>).detail;
    if (!detail || detail.handled) return;
    const context = options.context(),
      model = editor.getModel();
    if (
      !context?.source ||
      !model ||
      context.projectRoot !== detail.projectRoot ||
      context.source.path !== detail.edit.path
    )
      return;
    detail.handled = true;
    if (
      context.readonly ||
      editor.getOption(monaco.editor.EditorOption.readOnly) ||
      model.getValue() !== detail.originalContent ||
      !Number.isInteger(detail.edit.start) ||
      !Number.isInteger(detail.edit.end) ||
      detail.edit.start < 0 ||
      detail.edit.end < detail.edit.start ||
      detail.edit.end > detail.originalContent.length
    ) {
      detail.reply(false);
      return;
    }
    if (detail.validateOnly) {
      detail.reply(true);
      return;
    }
    const start = model.getPositionAt(detail.edit.start),
      end = model.getPositionAt(detail.edit.end);
    editor.pushUndoStop();
    const applied = editor.executeEdits('blode-ai', [
      {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        text: detail.edit.text,
        forceMoveMarkers: true,
      },
    ]);
    editor.pushUndoStop();
    detail.reply(applied);
  };
  window.addEventListener('blode:ai-context-request', contextRequested);
  window.addEventListener('blode:ai-apply-local', apply);
  return {
    dispose() {
      actions.forEach((action) => action.dispose());
      window.removeEventListener('blode:ai-context-request', contextRequested);
      window.removeEventListener('blode:ai-apply-local', apply);
    },
  };
}
