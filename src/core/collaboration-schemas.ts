import * as z from 'zod';
import { COLLABORATION_COLORS } from '../shared/collaboration';

const root = z.string().min(1).max(4096);
const path = z.string().min(1).max(1024);
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().nonnegative();
const line = z.number().int().min(1).max(1_000_001);
const actorToken = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();
export const collaborationSchemas = {
  state: z.object({}).strict(),
  open: z.object({ projectRoot: root, path }).strict(),
  presence: z
    .object({
      projectRoot: root,
      session: id.optional(),
      sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      actorToken,
      identity: z
        .object({
          userId: id,
          peerId: id,
          name: z.string().trim().min(1).max(40),
          color: z.enum(COLLABORATION_COLORS).optional(),
        })
        .strict(),
      path: z.string().max(1024),
      startLine: line,
      endLine: line,
      cursor: z
        .object({ line, column: z.number().int().min(1).max(1_000_001) })
        .strict()
        .optional(),
      editing: z.boolean(),
      openPaths: z.array(path).max(256).optional(),
      openTools: z
        .array(z.enum(['layout', 'ai']))
        .max(2)
        .optional(),
      activeTool: z.enum(['layout', 'ai']).optional(),
      clientKind: z.enum(['desktop', 'web']).optional(),
      attention: z.enum(['active', 'inactive']).optional(),
      attentionEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict()
    .refine((input) => input.endLine >= input.startLine),
  edit: z
    .object({
      projectRoot: root,
      session: id,
      path,
      peerId: id,
      actorToken,
      requestId: id,
      baseRevision: revision,
      changes: z
        .array(z.object({ start: revision, end: revision, text: z.string().max(1_000_000) }).strict())
        .min(1)
        .max(256),
    })
    .strict(),
  undo: z
    .object({
      projectRoot: root,
      session: id,
      path,
      peerId: id,
      actorToken,
      requestId: id,
      direction: z.enum(['undo', 'redo']),
      scope: z.enum(['own', 'global']).optional(),
    })
    .strict(),
  save: z.object({ projectRoot: root, session: id, path, revision }).strict(),
  resolve: z
    .object({
      projectRoot: root,
      session: id,
      path,
      revision,
      content: z.string().max(1_000_000),
      diskContent: z.string().max(1_000_000),
    })
    .strict(),
  leave: z
    .object({
      peerId: id,
      actorToken,
      projectRoot: root.optional(),
      session: id.optional(),
      sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
};
