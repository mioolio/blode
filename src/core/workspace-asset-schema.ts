import * as z from 'zod';

export const workspaceAssetRequestSchema = z
  .object({
    expectedProjectRoot: z.string().max(4096),
    path: z.string().min(1).max(1024),
  })
  .strict();
