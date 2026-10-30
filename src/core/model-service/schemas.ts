import * as z from 'zod';

const provider = z.enum(['deepseek', 'qwen', 'siliconflow', 'custom']);
const session = z
  .object({ sessionId: z.string().uuid(), sessionToken: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const modelServiceParameterSchemas = {
  'model.state': z.object({}).strict(),
  'model.configure': z
    .object({
      revision: z.number().int().nonnegative(),
      provider,
      baseUrl: z.string().trim().min(1).max(2048),
      model: z.string().trim().max(256),
      predictionModel: z.string().trim().max(256),
      predictionSource: z.enum(['external', 'provider']),
      apiKey: z.string().trim().max(8192).optional(),
      removeKey: z.boolean().optional(),
      confirm: z.literal(true),
    })
    .strict(),
  'model.test': z.object({}).strict(),
  'ai.chat.start': z
    .object({
      projectRoot: z.string().max(4096),
      scope: z.enum(['selection', 'file', 'project', 'computer']),
      intent: z.enum(['ask', 'edit']),
      prompt: z.string().trim().min(1).max(32_000),
      source: z
        .object({
          path: z.string().min(1).max(1024),
          content: z.string().max(1_000_000),
          selection: z
            .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
      sessionId: z.string().uuid().optional(),
      sessionToken: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      actor: z
        .object({ peerId: z.string().min(1).max(128), actorToken: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .optional(),
      localOnly: z.boolean().optional(),
      confirm: z.literal(true).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.intent === 'edit' || value.scope === 'computer') && value.confirm !== true)
        context.addIssue({ code: 'custom', message: 'confirmation required' });
      if (value.scope !== 'computer' && !value.projectRoot)
        context.addIssue({ code: 'custom', message: 'project required' });
      if ((value.scope === 'selection' || value.scope === 'file') && !value.source)
        context.addIssue({ code: 'custom', message: 'source required' });
      if (
        value.scope === 'selection' &&
        (!value.source?.selection ||
          value.source.selection.end <= value.source.selection.start ||
          value.source.selection.end > value.source.content.length)
      )
        context.addIssue({ code: 'custom', message: 'selection required' });
      if (!!value.sessionId !== !!value.sessionToken)
        context.addIssue({ code: 'custom', message: 'session credentials required' });
      if (value.localOnly && value.scope === 'computer')
        context.addIssue({ code: 'custom', message: 'computer mode uses host operations' });
    }),
  'ai.chat.state': session,
  'ai.chat.cancel': session,
} as const;
