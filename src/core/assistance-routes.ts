import * as z from 'zod';
import type { AiAssistance } from './ai-assistance';
import { aiParameterSchemas } from './ai-schemas';
import type { CollaborationService } from './collaboration';
import { collaborationSchemas } from './collaboration-schemas';
import type { UiCommands } from './ui-commands';
import { uiStateSchema, uiReplySchema } from './ui-commands';

export function createAssistanceRoutes(
  ai: AiAssistance,
  collaboration: CollaborationService,
  ui: UiCommands,
  trustedLocal = false,
) {
  const routes: Record<string, { args: z.ZodType; run: (...args: any[]) => unknown }> = {
    aiAssistanceState: { args: z.tuple([]), run: () => ai.aiAssistanceState() },
    aiAssistanceConfigure: {
      args: z.tuple([aiParameterSchemas['ai.configure']]),
      run: (input) => ai.aiAssistanceConfigure(input),
    },
    aiPredictionRequest: {
      args: z.tuple([aiParameterSchemas['ai.prediction.request']]),
      run: (input) => ai.aiPredictionRequest(input),
    },
    aiPredictionCancel: {
      args: z.tuple([aiParameterSchemas['ai.prediction.cancel']]),
      run: (input) => ai.aiPredictionCancel(input),
    },
    aiPredictionPoll: {
      args: z.tuple([aiParameterSchemas['ai.predictions.poll']]),
      run: (input) => ai.aiPredictionPoll(input),
    },
    aiPredictionSubmit: {
      args: z.tuple([aiParameterSchemas['ai.prediction.submit']]),
      run: (input) => ai.aiPredictionSubmit(input),
    },
    aiPredictionRead: {
      args: z.tuple([aiParameterSchemas['ai.prediction.read']]),
      run: (input) => ai.aiPredictionRead(input),
    },
    collaborationState: { args: z.tuple([]), run: () => collaboration.state() },
    collaborationOpen: {
      args: z.tuple([z.string(), z.string()]),
      run: (root, path) => collaboration.open(root, path),
    },
    collaborationPresence: {
      args: z.tuple([collaborationSchemas.presence]),
      run: (input) => collaboration.presence(input, trustedLocal),
    },
    collaborationEdit: {
      args: z.tuple([collaborationSchemas.edit]),
      run: (input) => collaboration.edit(input, trustedLocal),
    },
    collaborationUndo: {
      args: z.tuple([collaborationSchemas.undo]),
      run: (input) => collaboration.undo(input, trustedLocal),
    },
    collaborationSave: {
      args: z.tuple([collaborationSchemas.save]),
      run: (input) => collaboration.save(input),
    },
    collaborationResolve: {
      args: z.tuple([collaborationSchemas.resolve]),
      run: (input) => collaboration.resolve(input),
    },
    collaborationLeave: {
      args: z.tuple([z.union([z.string().min(1).max(128), collaborationSchemas.leave])]),
      run: (request) => collaboration.leave(request, trustedLocal),
    },
    uiPublishState: { args: z.tuple([uiStateSchema]), run: (input) => ui.publishState(input) },
    uiCommandReply: { args: z.tuple([uiReplySchema]), run: (input) => ui.reply(input) },
  };
  return {
    routes,
    async invoke(method: string, args: unknown[]) {
      if (!Object.hasOwn(routes, method)) throw new Error('rpc.methodNotFound');
      const route = routes[method];
      const parsed = route.args.safeParse(args);
      if (!parsed.success) throw new Error('rpc.invalidParams');
      return route.run(...(parsed.data as unknown[]));
    },
  };
}
