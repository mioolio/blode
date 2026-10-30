import * as z from 'zod';

export const breakpointLocationsSchema = z.array(z.string().min(1).max(1024)).min(1).max(128);
export const debuggerPatchSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    address: z.number().int().min(0).max(0xffffffff),
    expected: z.string().min(4).max(32),
    bytes: z.string().min(4).max(32),
    pauseAndResume: z.boolean(),
    confirm: z.literal(true),
  })
  .strict();
export const debuggerAssembleSchema = z
  .object({
    address: z.number().int().min(0).max(0xffffffff),
    source: z.string().min(1).max(512),
  })
  .strict();
export type DebuggerPatchRequest = z.infer<typeof debuggerPatchSchema>;
export interface DebuggerPatchResult {
  address: number;
  before: string;
  after: string;
  resumed: boolean;
}
export interface DebuggerBreakpointResult {
  location: string;
  id?: string;
  status: 'added' | 'existing' | 'failed';
  error?: string;
}
