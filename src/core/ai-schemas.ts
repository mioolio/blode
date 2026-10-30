import * as z from 'zod';

const entry = z
  .object({
    language: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    owner: z
      .string()
      .regex(/^[A-Za-z_]\w*(?:::\w+)*$/)
      .max(128)
      .optional(),
    name: z.string().min(1).max(128),
    kind: z.enum(['function', 'method', 'variable', 'constant', 'type', 'keyword', 'snippet', 'property']),
    detail: z.string().max(1024),
    documentation: z.string().max(8192).optional(),
    insertText: z.string().max(16384).optional(),
    sortText: z.string().max(128).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
const id = z.string().min(1).max(128);
const projectPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes(':') &&
      !value.includes('\0') &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Project relative path required',
  );

/** Shared by native/web handlers and the machine-readable automation tool catalog. */
export const aiParameterSchemas = {
  'ai.state': z.object({}).strict(),
  'ai.configure': z
    .object({
      revision: z.number().int().nonnegative(),
      predictionEnabled: z.boolean().optional(),
      predictionDelayMs: z.number().int().min(100).max(10000).optional(),
      useBuiltins: z.boolean().optional(),
      entries: z.array(entry).max(1000).optional(),
      resetCatalog: z.boolean().optional(),
    })
    .strict(),
  'ai.prediction.request': z
    .object({
      editorId: id,
      projectRoot: z.string().min(1).max(4096),
      path: projectPath,
      modelVersion: z.number().int().positive(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      prefix: z.string().max(12000),
      suffix: z.string().max(12000),
      manual: z.boolean().optional(),
    })
    .strict(),
  'ai.prediction.cancel': z.object({ editorId: id, requestId: id.optional() }).strict(),
  'ai.predictions.poll': z.object({ after: z.number().int().nonnegative().optional() }).strict(),
  'ai.prediction.submit': z.object({ requestId: id, text: z.string().min(1).max(16384) }).strict(),
  'ai.prediction.read': z.object({ requestId: id }).strict(),
} as const;
