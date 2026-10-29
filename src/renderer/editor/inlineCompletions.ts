import type * as Monaco from 'monaco-editor';
import type { AiPredictionRequest, AiPredictionSuggestion } from '../../shared/ai';
import { setCompletionCatalog } from './completionProvider';

/** Only exact editor snapshots may accept a prediction, including after remote edits. */
export function predictionMatches(
  request: AiPredictionRequest,
  current: { projectRoot: string; path: string; modelVersion: number; line: number; column: number },
): boolean {
  return (
    request.projectRoot === current.projectRoot &&
    request.path === current.path &&
    request.modelVersion === current.modelVersion &&
    request.line === current.line &&
    request.column === current.column &&
    Date.parse(request.expiresAt) > Date.now()
  );
}

/** External AI supplies ghost text. No model service, credentials or background generation. */
export function attachInlineCompletions(
  monaco: typeof import('monaco-editor/esm/vs/editor/editor.api.js'),
  editor: Monaco.editor.IStandaloneCodeEditor,
  scope: { projectRoot: () => string; path: () => string; acceptLabel?: string },
): Monaco.IDisposable {
  const editorId =
    globalThis.crypto?.randomUUID?.() ?? `editor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const listeners = new Set<() => void>();
  const visibleKey = editor.createContextKey<boolean>('blodeAIPredictionVisible', false);
  let enabled = false;
  let disposed = false;
  let generation = 0;
  let request: AiPredictionRequest | null = null;
  let suggestion: AiPredictionSuggestion | null = null;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const fire = () => listeners.forEach((listener) => listener());
  const invalidate = () => {
    generation += 1;
    clearTimeout(timer);
    clearTimeout(expiry);
    const previous = request;
    request = null;
    suggestion = null;
    shown = false;
    visibleKey.set(false);
    fire();
    if (previous) void window.blode.aiPredictionCancel({ editorId, requestId: previous.id }).catch(() => {});
  };
  const current = () => {
    const model = editor.getModel();
    const cursor = editor.getPosition();
    return model && cursor
      ? {
          projectRoot: scope.projectRoot(),
          path: scope.path(),
          modelVersion: model.getVersionId(),
          line: cursor.lineNumber,
          column: cursor.column,
        }
      : null;
  };
  const matches = () => {
    const snapshot = current();
    return !!(enabled && request && snapshot && predictionMatches(request, snapshot));
  };
  const readSuggestion = async () => {
    const active = request;
    if (!active || !enabled) return;
    try {
      const next = await window.blode.aiPredictionRead({ requestId: active.id });
      if (disposed || request?.id !== active.id || !matches() || !next) return;
      suggestion = next;
      fire();
      editor.trigger('blode-ai', 'editor.action.inlineSuggest.trigger', null);
    } catch {
      /* AI disconnects do not interrupt typing. */
    }
  };
  const schedule = () => {
    invalidate();
    if (!enabled || disposed || !editor.hasTextFocus()) return;
    const version = generation;
    timer = setTimeout(async () => {
      const snapshot = current();
      const model = editor.getModel();
      const cursor = editor.getPosition();
      if (!snapshot?.projectRoot || !snapshot.path || !model || !cursor || !editor.hasTextFocus()) return;
      const offset = model.getOffsetAt(cursor);
      const text = model.getValue();
      try {
        const next = await window.blode.aiPredictionRequest({
          ...snapshot,
          editorId,
          prefix: text.slice(Math.max(0, offset - 12000), offset),
          suffix: text.slice(offset, offset + 12000),
        });
        if (disposed || version !== generation || !enabled) {
          if (next) void window.blode.aiPredictionCancel({ editorId, requestId: next.id }).catch(() => {});
          return;
        }
        request = next;
        if (!matches()) {
          invalidate();
          return;
        }
        expiry = setTimeout(invalidate, Math.max(0, Date.parse(next!.expiresAt) - Date.now()));
        await readSuggestion();
      } catch {
        /* An unavailable external AI leaves normal completions intact. */
      }
    }, 450);
  };
  const loadSettings = async () => {
    try {
      const state = await window.blode.aiAssistanceState();
      if (disposed) return;
      setCompletionCatalog(state);
      enabled = state.predictionEnabled;
      schedule();
    } catch {
      enabled = false;
      invalidate();
    }
  };
  const provider = monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      onDidChangeInlineCompletions: (listener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
      provideInlineCompletions(model, position) {
        shown = false;
        visibleKey.set(false);
        if (
          disposed ||
          model !== editor.getModel() ||
          !editor.hasTextFocus() ||
          !matches() ||
          !suggestion ||
          !request ||
          position.lineNumber !== request.line ||
          position.column !== request.column
        )
          return { items: [] };
        return {
          items: [
            {
              insertText: suggestion.text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
              correlationId: request.id,
            },
          ],
          enableForwardStability: false,
        };
      },
      handleItemDidShow(_completions, item) {
        shown = item.correlationId === request?.id && matches();
        visibleKey.set(shown);
      },
      disposeInlineCompletions() {
        /* The next editor snapshot, not a disposal race, invalidates the request. */
      },
    },
  );
  const subscriptions = [
    provider,
    editor.onDidChangeModelContent(schedule),
    editor.onDidChangeCursorPosition(schedule),
    editor.onDidChangeModel(schedule),
    editor.onDidFocusEditorText(schedule),
    editor.onDidBlurEditorText(invalidate),
    editor.addAction({
      id: `blode.ai.accept.${editorId}`,
      label: scope.acceptLabel ?? 'ai.completions.acceptPrediction',
      keybindings: [monaco.KeyCode.Tab],
      precondition:
        'blodeAIPredictionVisible && inlineSuggestionVisible && editorTextFocus && !editorReadonly',
      run() {
        if (!shown || !suggestion || !matches()) return;
        const position = editor.getPosition()!;
        const text = suggestion.text;
        invalidate();
        editor.pushUndoStop();
        editor.executeEdits('blode-ai-prediction', [
          {
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
            text,
            forceMoveMarkers: true,
          },
        ]);
        editor.pushUndoStop();
      },
    }),
    editor.onKeyDown((event) => {
      if (event.keyCode === monaco.KeyCode.Escape && request) {
        invalidate();
        return;
      }
    }),
  ];
  const unsubscribe = window.blode.onEvent((event) => {
    if (event.message === 'status.aiAssistanceChanged') void loadSettings();
    if (request && event.message === `status.aiPredictionReady ${request.id}`) void readSuggestion();
  });
  void loadSettings();
  return {
    dispose() {
      disposed = true;
      invalidate();
      unsubscribe();
      subscriptions.forEach((item) => item.dispose());
      listeners.clear();
    },
  };
}
