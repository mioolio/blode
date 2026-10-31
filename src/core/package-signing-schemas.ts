import * as z from 'zod';
export const packageApprovalSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    allowUntrusted: z.literal(true).optional(),
    allowModified: z.literal(true).optional(),
  })
  .strict();
export const packageInspectSchema = z
  .object({
    path: z.string().min(1).max(4096),
    kind: z.enum(['device', 'extension', 'component', 'tool', 'application']),
  })
  .strict();
