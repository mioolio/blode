import * as z from 'zod';
export const toolVersionSchemas = {
  state: z.object({}).strict(),
  install: z.object({ id: z.string().min(1).max(128), confirm: z.literal(true) }).strict(),
  select: z.object({ id: z.string().min(1).max(128) }).strict(),
};
