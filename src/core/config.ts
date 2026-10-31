import * as z from 'zod';
import { getBoardAdapter } from '../../extensions/registry';
import { configSchema } from './config-schema';
export { configSchema, debuggerSettingsRequestSchema } from './config-schema';
import type { ProjectConfig, ProjectBuildInputs } from '../shared/contracts';
import { migrateLegacyBuildPlatforms } from '../shared/runtime-identity';

export function parseConfig(value: unknown): ProjectConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error('error.invalidConfig');
  // Board definitions are only trusted when they live in the registered boards folder.
  // Retired universal configurations must be identified again before any build or write.
  // Their original transport and capacities are never guessed into a supported platform.
  const config: ProjectConfig =
    result.data.boardId === 'generic'
      ? {
          ...getBoardAdapter('auto').createConfig(),
          name: result.data.name,
          port: result.data.port,
          toolchain: result.data.toolchain,
        }
      : result.data.boardId === 'auto'
        ? {
            ...result.data,
            flashSize: 0,
            partitions: [],
            programmer: result.data.programmer ?? getBoardAdapter('auto').createConfig().programmer,
          }
        : result.data;
  const adapter = getBoardAdapter(config.boardId);
  adapter.validateConfig(config);
  return config;
}

/** Build inputs declared by the `be` project descriptor. */
export type ProjectBuild = ProjectBuildInputs;

const buildPath = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value));
const compilerChoiceSchema = z
  .object({
    family: z.enum(['inherit', 'auto', 'gnu-arm', 'armclang', 'armcc', 'arduino', 'plugin']),
    pluginId: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
      .optional(),
    directory: buildPath.optional(),
    version: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/)
      .optional(),
    arduinoCli: buildPath.optional(),
    packageDirectory: buildPath.optional(),
  })
  .strict();
const platformCompilerSettingsSchema = z
  .object({
    common: compilerChoiceSchema.optional(),
    c: compilerChoiceSchema.optional(),
    cpp: compilerChoiceSchema.optional(),
  })
  .strict();
const buildSettingsSchema = z
  .object({
    mode: z.enum(['debug', 'release']).optional(),
    optimizeForSize: z.boolean().optional(),
    common: compilerChoiceSchema.optional(),
    platforms: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/), platformCompilerSettingsSchema)
      .optional(),
  })
  .strict();

const singleBuildSchema = z
  .object({
    settings: buildSettingsSchema.optional(),
    cStandard: z.enum(['c99', 'c11', 'c17', 'c23']).optional(),
    entry: z.string().trim().min(1).max(1024).optional(),
    sketch: z.string().trim().min(1).max(1024).optional(),
    files: z.array(z.string().trim().min(1).max(1024)).max(1000).optional(),
  })
  .strict();
const targetRoot = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value === '.' ||
      (/^(?![./\\])[^\\:\x00-\x1f]+$/.test(value) &&
        value.split('/').every((part) => part !== '..' && part !== '.' && !!part && !part.startsWith('.'))),
  );
const buildSchema = singleBuildSchema
  .extend({
    targets: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
            name: z.string().trim().min(1).max(120),
            root: targetRoot,
            config: configSchema
              .partial()
              .extend({
                toolchain: configSchema.shape.toolchain.partial().optional(),
                programmer: configSchema.shape.programmer.unwrap().partial().optional(),
              })
              .optional(),
            build: singleBuildSchema.optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    defaultTarget: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
      .optional(),
  })
  .superRefine((value, context) => {
    const ids = value.targets?.map((target) => target.id) ?? [];
    if (
      new Set(ids.map((id) => id.toLowerCase())).size !== ids.length ||
      (value.defaultTarget && !ids.includes(value.defaultTarget))
    )
      context.addIssue({ code: 'custom', message: 'Invalid build target selection' });
  });

export function parseProjectBuild(value: unknown): ProjectBuild {
  if (value === undefined || value === null) return {};
  const result = buildSchema.safeParse(migrateLegacyBuildPlatforms(value));
  if (!result.success) throw new Error('error.invalidProjectDescriptor');
  return result.data;
}

/** A `be` file is a JSON project descriptor: configuration plus explicit build inputs. */
export function parseProjectDescriptor(value: unknown): {
  config: ProjectConfig;
  build: ProjectBuild;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('error.invalidProjectDescriptor');
  const { build, ...configValue } = value as Record<string, unknown>;
  return { config: parseConfig(configValue), build: parseProjectBuild(build) };
}
