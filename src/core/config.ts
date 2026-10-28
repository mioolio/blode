import { z } from 'zod';
import { getBoardAdapter } from '../../extensions/registry';
import type { ProjectConfig, ProjectBuildInputs } from '../shared/contracts';

const partitionSchema = z
  .object({
    id: z.string().min(1).max(16),
    name: z.string().min(1).max(16),
    type: z.enum(['app', 'data', 'system']),
    offset: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(80),
    boardId: z.string().regex(/^[a-z0-9-]+$/),
    port: z.string().max(128),
    baudRate: z.number().int().min(1_200).max(3_000_000),
    flashSize: z.number().int().nonnegative(),
    flashSizeOverride: z.boolean().optional(),
    partitions: z.array(partitionSchema).max(32),
    programmer: z
      .object({
        transport: z.enum(['auto', 'serial', 'stlink']),
        serialNumber: z.string().regex(/^[a-fA-F0-9]{0,64}$/),
        frequencyKhz: z.number().int().min(5).max(4000),
        targetChipId: z
          .string()
          .regex(/^0x[a-fA-F0-9]{3,8}$/)
          .optional(),
      })
      .strict()
      .optional(),
    toolchain: z
      .object({
        mode: z.enum(['managed', 'custom']),
        arduinoCli: z.string().max(1024),
        python: z.string().max(1024),
        additionalUrls: z
          .array(
            z
              .string()
              .url()
              .refine((value) => /^https:\/\//.test(value), 'HTTPS required'),
          )
          .max(16),
        fqbn: z.string().regex(/^(?:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_=,.-]+)?)?$/),
        stlinkDirectory: z.string().max(1024).optional(),
        armCompilerDirectory: z.string().max(1024).optional(),
      })
      .strict(),
  })
  .strict();

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

const buildSchema = z
  .object({
    entry: z.string().trim().min(1).max(1024).optional(),
    sketch: z.string().trim().min(1).max(1024).optional(),
    files: z.array(z.string().trim().min(1).max(1024)).max(1000).optional(),
  })
  .strict();

export function parseProjectBuild(value: unknown): ProjectBuild {
  if (value === undefined || value === null) return {};
  const result = buildSchema.safeParse(value);
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
