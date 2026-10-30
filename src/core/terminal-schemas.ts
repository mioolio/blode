import * as z from 'zod';

const terminalId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/)
  .optional();
const sessionId = z.string().max(128).optional();
const target = { terminalId, sessionId };
const size = { cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) };

export const terminalParameterSchemas = {
  'terminal.sessions': z.object({}).strict(),
  'terminal.state': z.object({ ...target, after: z.number().int().nonnegative().optional() }).strict(),
  'terminal.open': z
    .object({
      terminalId,
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .refine((value) => !/[\x00-\x1f]/.test(value))
        .optional(),
      create: z.boolean().optional(),
      cols: size.cols.optional(),
      rows: size.rows.optional(),
      confirm: z.literal(true),
    })
    .strict(),
  'terminal.run': z
    .object({ ...target, command: z.string().trim().min(1).max(16384), confirm: z.literal(true) })
    .strict(),
  'terminal.stop': z.object(target).strict(),
  'terminal.write': z
    .object({
      ...target,
      data: z
        .string()
        .max(32768)
        .refine((value) => !value.includes('\0')),
      confirm: z.literal(true),
    })
    .strict(),
  'terminal.resize': z.object({ ...target, ...size }).strict(),
  'terminal.close': z.object({ ...target, confirm: z.literal(true) }).strict(),
} as const;
