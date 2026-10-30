import * as z from 'zod';
import { gitParameterSchemas } from './git-schemas';
import { toolVersionSchemas } from './tool-version-schemas';
import { configSchema } from './config';
import { RUNTIME_VIEW_KIND_PATTERN } from '../shared/plugins';
const empty = z.object({}).strict();
export const hostParameterSchemas = {
  'components.state': empty,
  'components.search': z.object({ query: z.string().trim().min(1).max(200) }).strict(),
  'components.install': z
    .object({
      name: z.string().trim().min(1).max(160),
      version: z.string().trim().min(1).max(80),
      expectedProjectRoot: z.string().min(1).max(4096),
      confirm: z.literal(true),
    })
    .strict(),
  'components.import': z
    .object({
      path: z.string().min(1).max(4096),
      kind: z.enum(['directory', 'archive']),
      expectedProjectRoot: z.string().min(1).max(4096),
      confirm: z.literal(true),
    })
    .strict(),
  'components.remove': z
    .object({
      id: z.string().min(1).max(160),
      expectedProjectRoot: z.string().min(1).max(4096),
      confirm: z.literal(true),
    })
    .strict(),
  'runtime.plugins': empty,
  'runtime.context': z.object({ id: z.string().min(1).max(80) }).strict(),
  'runtime.configure': z
    .object({
      id: z.string().min(1).max(80),
      value: configSchema.shape.runtime
        .unwrap()
        .pick({ deviceId: true, values: true, disabledCapabilities: true }),
    })
    .strict(),
  'runtime.device': z
    .object({
      id: z.string().min(1).max(80),
      method: z.string().min(1).max(80),
      args: z.array(z.unknown()).max(8),
      confirm: z.literal(true).optional(),
    })
    .strict(),
  'runtime.trust': z
    .object({
      id: z.string().min(1).max(80),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      confirm: z.literal(true),
      permanent: z.boolean(),
    })
    .strict(),
  'runtime.view': z
    .object({ id: z.string().min(1).max(80), kind: z.string().regex(RUNTIME_VIEW_KIND_PATTERN) })
    .strict(),
  'runtime.view.info': z
    .object({
      id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
      viewId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
    })
    .strict(),
  'runtime.debug': z
    .object({
      id: z.string().min(1).max(80),
      method: z.string().min(1).max(80),
      args: z.array(z.unknown()).max(8),
    })
    .strict(),
  'language.index': empty,
  ...gitParameterSchemas,
  'tools.versions': toolVersionSchemas.state,
  'tools.installVersion': toolVersionSchemas.install,
  'tools.selectVersion': toolVersionSchemas.select,
  'host.browse': z.object({ path: z.string().min(1).max(4096).optional() }).strict(),
  'vscode.open': z
    .object({
      expectedProjectRoot: z.string().min(1).max(4096),
      path: z.string().min(1).max(1024).optional(),
      line: z.number().int().min(1).max(10_000_000).optional(),
      column: z.number().int().min(1).max(10_000_000).optional(),
      confirm: z.literal(true),
    })
    .strict()
    .refine((value) => value.path || (value.line === undefined && value.column === undefined)),
  'project.package.preview': empty,
  'project.package.export': z
    .object({ confirmExternal: z.literal(true).optional(), allowIncomplete: z.literal(true).optional() })
    .strict(),
  'terminal.state': z
    .object({ sessionId: z.string().max(128).optional(), after: z.number().int().nonnegative().optional() })
    .strict(),
  'terminal.open': z
    .object({
      cols: z.number().int().min(20).max(500).optional(),
      rows: z.number().int().min(5).max(300).optional(),
      confirm: z.literal(true),
    })
    .strict(),
  'terminal.run': z
    .object({ command: z.string().trim().min(1).max(16384), confirm: z.literal(true) })
    .strict(),
  'terminal.stop': empty,
  'terminal.write': z
    .object({
      data: z
        .string()
        .max(32768)
        .refine((value) => !value.includes('\0')),
      sessionId: z.string().max(128).optional(),
      confirm: z.literal(true),
    })
    .strict(),
  'terminal.resize': z
    .object({
      cols: z.number().int().min(20).max(500),
      rows: z.number().int().min(5).max(300),
      sessionId: z.string().max(128).optional(),
    })
    .strict(),
  'terminal.close': z.object({ confirm: z.literal(true) }).strict(),
} as const;
