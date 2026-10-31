import * as z from 'zod';
import { CLANGD_NOTIFICATION_METHODS, CLANGD_REQUEST_METHODS } from '../../shared/clangd';
import { lspRangeSchema, lspTextDocumentSchema } from '../lsp-schemas';

const projectRoot = z.string().min(1).max(4096);
const workspacePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/[\\\0\r\n]/.test(value) &&
      !value.split('/').some((part) => part === '..' || part === '.' || !part),
    { message: 'invalid workspace path' },
  );

export const clangdRequestSchema = z
  .object({
    expectedProjectRoot: projectRoot,
    method: z.enum([...CLANGD_REQUEST_METHODS]),
    params: z.unknown().optional(),
  })
  .strict();
export const clangdNotifySchema = z
  .object({
    expectedProjectRoot: projectRoot,
    messages: z
      .array(z.object({ method: z.enum([...CLANGD_NOTIFICATION_METHODS]), params: z.unknown() }).strict())
      .min(1)
      .max(32),
  })
  .strict();
export const clangdDiagnosticsSchema = z
  .object({ expectedProjectRoot: projectRoot, path: workspacePath })
  .strict();

export const clangdFormattingParamsSchema = z
  .object({ textDocument: lspTextDocumentSchema, options: z.unknown().optional() })
  .strict();
export const clangdRangeFormattingParamsSchema = z
  .object({
    textDocument: lspTextDocumentSchema,
    range: lspRangeSchema,
    options: z.unknown().optional(),
  })
  .strict();
export const clangdCodeActionParamsSchema = z
  .object({
    textDocument: lspTextDocumentSchema,
    range: lspRangeSchema,
    context: z
      .object({
        diagnostics: z.array(z.unknown()).max(200).default([]),
        only: z.array(z.string().min(1).max(128)).max(16).optional(),
        triggerKind: z.number().int().min(1).max(2).optional(),
      })
      .strict(),
  })
  .strict();
export const clangdExecuteCommandParamsSchema = z
  .object({
    command: z.string().min(1).max(128),
    arguments: z.array(z.unknown()).max(32).optional(),
  })
  .strict();
export const clangdWorkspaceSymbolParamsSchema = z.object({ query: z.string().max(256) }).strict();
export const clangdDocumentSymbolParamsSchema = z.object({ textDocument: lspTextDocumentSchema }).strict();

export type ClangdRequestInput = z.infer<typeof clangdRequestSchema>;
export type ClangdNotifyInput = z.infer<typeof clangdNotifySchema>;
export type ClangdDiagnosticsInput = z.infer<typeof clangdDiagnosticsSchema>;
