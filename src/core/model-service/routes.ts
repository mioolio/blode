import * as z from 'zod';
import { ModelService } from './index';
import { modelServiceParameterSchemas as schemas } from './schemas';

export function createModelRoutes(service: ModelService) {
  const routes = {
    modelServiceState: { args: z.tuple([]), run: () => service.state() },
    modelServiceConfigure: {
      args: z.tuple([schemas['model.configure']]),
      run: (input: z.infer<(typeof schemas)['model.configure']>) => service.configure(input),
    },
    modelServiceTest: { args: z.tuple([]), run: () => service.test() },
    aiChatStart: {
      args: z.tuple([schemas['ai.chat.start']]),
      run: (input: z.infer<(typeof schemas)['ai.chat.start']>) => service.start(input),
    },
    aiChatState: {
      args: z.tuple([schemas['ai.chat.state']]),
      run: (input: z.infer<(typeof schemas)['ai.chat.state']>) => service.stateOf(input),
    },
    aiChatCancel: {
      args: z.tuple([schemas['ai.chat.cancel']]),
      run: (input: z.infer<(typeof schemas)['ai.chat.cancel']>) => service.cancel(input),
    },
  };
  const aliases: Record<string, [string, (input: any) => unknown[]]> = {
    'model.state': ['modelServiceState', () => []],
    'model.configure': ['modelServiceConfigure', (input) => [input]],
    'model.test': ['modelServiceTest', () => []],
    'ai.chat.start': ['aiChatStart', (input) => [input]],
    'ai.chat.state': ['aiChatState', (input) => [input]],
    'ai.chat.cancel': ['aiChatCancel', (input) => [input]],
  };
  return { routes, aliases };
}
