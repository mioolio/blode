import * as z from 'zod';
import { LSP_NOTIFICATION_METHODS, LSP_REQUEST_METHODS } from '../shared/lsp';

const projectRoot = z.string().min(1).max(4096);
const documentUri = z.string().min(1).max(4096);
const version = z.number().int().min(0).max(2_147_483_647);
export const lspPositionSchema = z
  .object({
    line: z.number().int().min(0).max(1_000_000),
    character: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export const lspRangeSchema = z.object({ start: lspPositionSchema, end: lspPositionSchema }).strict();
export const lspTextDocumentSchema = z.object({ uri: documentUri }).strict();
const position = lspPositionSchema;
const textDocument = lspTextDocumentSchema;
const textDocumentPosition = z.object({ textDocument, position }).strict();

export const lspCompletionParamsSchema = z
  .object({ textDocument, position, context: z.unknown().optional() })
  .strict();
export const lspHoverParamsSchema = textDocumentPosition;
export const lspDidOpenParamsSchema = z
  .object({
    textDocument: z
      .object({
        uri: documentUri,
        languageId: z.string().min(1).max(64),
        version,
        text: z.string().max(1_000_000),
      })
      .strict(),
  })
  .strict();
export const lspDidChangeParamsSchema = z
  .object({
    textDocument: z.object({ uri: documentUri, version }).strict(),
    contentChanges: z
      .array(z.object({ text: z.string().max(1_000_000) }).strict())
      .min(1)
      .max(8),
  })
  .strict();
export const lspDidCloseParamsSchema = z.object({ textDocument }).strict();

/** Transport envelopes shared by IPC, the Web host RPC and their tests. */
export const lspRequestSchema = z
  .object({
    expectedProjectRoot: projectRoot,
    method: z.enum([...LSP_REQUEST_METHODS]),
    params: z.unknown().optional(),
  })
  .strict();
export const lspNotifySchema = z
  .object({
    expectedProjectRoot: projectRoot,
    messages: z
      .array(z.object({ method: z.enum([...LSP_NOTIFICATION_METHODS]), params: z.unknown() }).strict())
      .min(1)
      .max(32),
  })
  .strict();
export type LspRequestInput = z.infer<typeof lspRequestSchema>;
export type LspNotifyInput = z.infer<typeof lspNotifySchema>;
