import * as z from 'zod';

const file = z.string().min(1).max(1024);
const branch = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\0\r\n]/.test(value) && !value.startsWith('-'));
const remote = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const gitActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('init') }).strict(),
  z
    .object({
      action: z.literal('setMode'),
      mode: z.enum(['isolated', 'shared', 'disabled']),
      confirm: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('removeRepository'),
      target: z.enum(['isolated', 'shared']),
      repositoryRoot: z.string().min(1).max(4096).optional(),
      confirm: z.literal(true),
    })
    .strict(),
  z.object({ action: z.literal('stage'), paths: z.array(file).min(1).max(1000) }).strict(),
  z.object({ action: z.literal('unstage'), paths: z.array(file).min(1).max(1000) }).strict(),
  z
    .object({
      action: z.literal('commit'),
      message: z.string().trim().min(1).max(16000),
      confirm: z.literal(true),
    })
    .strict(),
  z.object({ action: z.literal('createBranch'), branch }).strict(),
  z.object({ action: z.literal('checkout'), branch }).strict(),
  z.object({ action: z.literal('remoteSet'), name: remote, url: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('remoteRemove'), name: remote, confirm: z.literal(true) }).strict(),
  z
    .object({
      action: z.literal('configure'),
      name: z.string().trim().min(1).max(128),
      email: z.string().trim().min(3).max(254),
    })
    .strict(),
  z.object({ action: z.literal('fetch'), remote }).strict(),
  z
    .object({ action: z.literal('pull'), remote, branch: branch.optional(), confirm: z.literal(true) })
    .strict(),
  z
    .object({ action: z.literal('push'), remote, branch: branch.optional(), confirm: z.literal(true) })
    .strict(),
]);
export const gitParameterSchemas = {
  'git.status': z.object({}).strict(),
  'git.diff': z.object({ path: file, staged: z.boolean().optional() }).strict(),
  'git.action': gitActionSchema,
} as const;
