import * as z from 'zod';
import { gitParameterSchemas } from './git-schemas';
import { toolVersionSchemas } from './tool-version-schemas';
const empty = z.object({}).strict();
export const hostParameterSchemas = {
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
