import * as z from 'zod';

const projectRoot = z.string().min(1).max(4096);
const workspacePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/[\\\0\r\n]/.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    { message: 'invalid workspace path' },
  );

export const explorerStateSchema = z
  .object({
    version: z.literal(1),
    collapsed: z.array(workspacePath).max(5000),
    rootCollapsed: z.boolean(),
  })
  .strict();
export const explorerStateSaveSchema = z
  .object({ expectedProjectRoot: projectRoot, state: explorerStateSchema })
  .strict();
export type ExplorerStateSaveInput = z.infer<typeof explorerStateSaveSchema>;
