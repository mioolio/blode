import type { AiChatRequest, AiSourceContext } from '../../shared/model-service';

export interface AiEditorContext {
  projectRoot: string;
  source?: AiSourceContext;
  readonly?: boolean;
  actor?: AiChatRequest['actor'];
}
export function currentAiContext(fallback?: AiEditorContext): AiEditorContext | undefined {
  let context = fallback;
  window.dispatchEvent(
    new CustomEvent('blode:ai-context-request', {
      detail: {
        reply: (value: AiEditorContext) => {
          context = value;
        },
      },
    }),
  );
  let actor: AiChatRequest['actor'];
  window.dispatchEvent(
    new CustomEvent('blode:ai-actor-request', {
      detail: {
        reply: (value: AiChatRequest['actor']) => {
          actor = value;
        },
      },
    }),
  );
  return context ? { ...context, actor } : undefined;
}
export function openAiAssistant(intent: 'ask' | 'edit' = 'ask', context?: AiEditorContext) {
  window.dispatchEvent(
    new CustomEvent('blode:ai-open', { detail: { intent, context: context ?? currentAiContext() } }),
  );
}
