import * as z from 'zod';
import { gitParameterSchemas } from './git-schemas';
import { toolVersionSchemas } from './tool-version-schemas';
import { configSchema } from './config';
const empty = z.object({}).strict();
export const hostParameterSchemas = {
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
  'runtime.view': z.object({ id: z.string().min(1).max(80), kind: z.enum(['debugger', 'device']) }).strict(),
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
  'project.package.preview': empty,
  'project.package.export': z
    .object({ confirmExternal: z.literal(true).optional(), allowIncomplete: z.literal(true).optional() })
    .strict(),
  'terminal.state': empty,
  'terminal.run': z
    .object({ command: z.string().trim().min(1).max(16384), confirm: z.literal(true) })
    .strict(),
  'terminal.stop': empty,
} as const;
