import * as z from 'zod';

/** A frame is one UTF-8 JSON object followed by LF. This is not HTTP. */
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_QUEUED_REQUESTS = 8;
export const MAX_CONNECTIONS = 8;
export const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

export const requestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(128), z.number().int()]).optional(),
    method: z.string().min(1).max(80),
    auth: z.string().max(128),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type RpcRequest = z.infer<typeof requestSchema>;
export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export function errorResponse(id: string | number | null, error: RpcError): RpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
}

export interface ConnectionInfo {
  version: 1;
  endpoint: string;
  tokenFile: string;
  pid: number;
}

export const connectionSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    endpoint: z.string().min(1).max(512),
    tokenFile: z.string().min(1).max(4096),
    pid: z.number().int().positive(),
  })
  .strict();
