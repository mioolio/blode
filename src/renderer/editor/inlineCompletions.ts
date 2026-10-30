import type * as Monaco from 'monaco-editor';
import type { AiPredictionRequest, AiPredictionSuggestion } from '../../shared/ai';
import { setCompletionCatalog } from './completionProvider';

export interface PredictionFeedback {
  kind: 'idle' | 'requesting' | 'ready' | 'empty' | 'error';
  message?: string;
}

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

/** Ghost text uses exact editor versions; generation and credentials stay in the host. */
export function attachInlineCompletions(
  monaco: typeof import('monaco-editor/esm/vs/editor/editor.api.js'),
  editor: Monaco.editor.IStandaloneCodeEditor,
  scope: {
    projectRoot: () => string;
    path: () => string;
    acceptLabel?: string;
    completeLabel?: string;
    onStatus?: (feedback: PredictionFeedback) => void;
  },
): Monaco.IDisposable {
  const editorId =
    globalThis.crypto?.randomUUID?.() ?? `editor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const listeners = new Set<() => void>();
  const visibleKey = editor.createContextKey<boolean>('blodeAIPredictionVisible', false);
  let enabled = false;
  let delayMs = 750;
  let composing = false;
  let loaded = false;
  let disposed = false;
  let generation = 0;
  let manualGeneration: number | undefined;
  let request: AiPredictionRequest | null = null;
  let suggestion: AiPredictionSuggestion | null = null;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let responseTimeout: ReturnType<typeof setTimeout> | undefined;
  const status = (feedback: PredictionFeedback) => {
    if (!disposed) scope.onStatus?.(feedback);
  };
  const fire = () => listeners.forEach((listener) => listener());
  const invalidate = () => {
    generation += 1;
    manualGeneration = undefined;
    clearTimeout(timer);
    clearTimeout(expiry);
    clearTimeout(responseTimeout);
    timer = undefined;
    expiry = undefined;
    responseTimeout = undefined;
    const previous = request;
    request = null;
    suggestion = null;
    shown = false;
    visibleKey.set(false);
    editor.trigger('blode-ai', 'editor.action.inlineSuggest.hide', null);
    fire();
    status({ kind: 'idle' });
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
    return !!(
      (enabled || request?.manual) &&
      request &&
      snapshot &&
      !editor.getOption(monaco.editor.EditorOption.readOnly) &&
      predictionMatches(request, snapshot)
    );
  };
  const readSuggestion = async () => {
    const active = request;
    if (!active || (!enabled && !active.manual)) return;
    try {
      const next = await window.blode.aiPredictionRead({ requestId: active.id });
      if (disposed || request?.id !== active.id || !matches() || !next) return;
      clearTimeout(responseTimeout);
      if (!next.text) {
        status({ kind: 'empty', message: 'ai.completions.empty' });
        return;
      }
      suggestion = next;
      status({ kind: 'ready', message: 'ai.completions.ready' });
      fire();
      editor.trigger('blode-ai', 'editor.action.inlineSuggest.trigger', null);
    } catch (failure) {
      if (request?.id !== active.id || !matches() || disposed) return;
      clearTimeout(responseTimeout);
      const message =
        failure instanceof Error
          ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : '';
      status({
        kind: 'error',
        message: /^error\.[A-Za-z0-9]+$/.test(message) ? message : 'error.aiPredictionUnavailable',
      });
    }
  };
  const start = async (manual: boolean) => {
    invalidate();
    if (
      (!enabled && !manual) ||
      disposed ||
      composing ||
      !editor.hasTextFocus() ||
      editor.getOption(monaco.editor.EditorOption.readOnly)
    )
      return;
    const version = generation;
    if (manual) manualGeneration = version;
    const snapshot = current();
    const model = editor.getModel();
    const cursor = editor.getPosition();
    if (!snapshot?.projectRoot || !snapshot.path || !model || !cursor || !editor.hasTextFocus()) return;
    const offset = model.getOffsetAt(cursor);
    const text = model.getValue();
    status({ kind: 'requesting', message: 'ai.completions.requesting' });
    try {
      const next = await window.blode.aiPredictionRequest({
        ...snapshot,
        editorId,
        prefix: text.slice(Math.max(0, offset - 12000), offset),
        suffix: text.slice(offset, offset + 12000),
        ...(manual ? { manual: true } : {}),
      });
      if (disposed || version !== generation || (!enabled && !manual)) {
        if (next) void window.blode.aiPredictionCancel({ editorId, requestId: next.id }).catch(() => {});
        return;
      }
      if (!next) {
        status({ kind: 'error', message: 'error.aiPredictionUnavailable' });
        return;
      }
      request = next;
      if (!matches()) {
        invalidate();
        return;
      }
      expiry = setTimeout(invalidate, Math.max(0, Date.parse(next!.expiresAt) - Date.now()));
      responseTimeout = setTimeout(() => {
        if (request?.id !== next.id || !matches()) return;
        invalidate();
        status({ kind: 'error', message: 'error.aiPredictionTimeout' });
      }, 16000);
      await readSuggestion();
    } catch (failure) {
      if (disposed || generation !== version) return;
      const message =
        failure instanceof Error
          ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : '';
      status({
        kind: 'error',
        message: /^error\.[A-Za-z0-9]+$/.test(message) ? message : 'error.aiPredictionUnavailable',
      });
    }
  };
  const schedule = () => {
    invalidate();
    if (
      !enabled ||
      disposed ||
      composing ||
      !editor.hasTextFocus() ||
      editor.getOption(monaco.editor.EditorOption.readOnly)
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      void start(false);
    }, delayMs);
  };
  const loadSettings = async () => {
    try {
      const state = await window.blode.aiAssistanceState();
      if (disposed) return;
      setCompletionCatalog(state);
      enabled = state.predictionEnabled;
      delayMs = state.predictionDelayMs ?? 750;
      loaded = true;
      // A settings response can arrive between a context action and its host reply.
      // It must not cancel the deliberate one-shot action, even with auto disabled.
      if (manualGeneration !== generation) schedule();
    } catch {
      enabled = false;
      loaded = true;
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
    editor.onDidChangeCursorPosition(() => {
      if (timer) schedule();
      else invalidate();
    }),
    editor.onDidChangeModel(schedule),
    editor.onDidFocusEditorText(schedule),
    editor.onDidBlurEditorText(invalidate),
    editor.onDidCompositionStart(() => {
      composing = true;
      invalidate();
    }),
    editor.onDidCompositionEnd(() => {
      composing = false;
      schedule();
    }),
    editor.addAction({
      id: 'blode.ai.complete',
      label: scope.completeLabel ?? 'AI completion',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Space],
      contextMenuGroupId: '9_blode_ai',
      contextMenuOrder: 0,
      precondition: '!editorReadonly',
      async run() {
        editor.focus();
        if (!loaded) await loadSettings();
        await start(true);
      },
    }),
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
    if (
      request &&
      [`status.aiPredictionReady ${request.id}`, `status.aiPredictionFailed ${request.id}`].includes(
        event.message,
      )
    )
      void readSuggestion();
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
