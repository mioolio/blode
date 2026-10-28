import { z } from 'zod';
import { getBoardAdapter } from '../../extensions/registry';
import type { ProjectConfig } from '../shared/contracts';
import { validatePartitions } from './partitions';

const partitionSchema = z
  .object({
    id: z.string().min(1).max(16),
    name: z.string().min(1).max(16),
    type: z.enum(['app', 'data', 'system']),
    offset: z.number().int().nonnegative(),
    size: z.number().int().positive(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(80),
    boardId: z.string().regex(/^[a-z0-9-]+$/),
    port: z.string().max(128),
    baudRate: z.number().int().min(1_200).max(3_000_000),
    flashSize: z.number().int().positive(),
    partitions: z.array(partitionSchema).max(32),
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
      })
      .strict(),
  })
  .strict();

export function parseConfig(value: unknown): ProjectConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error('error.invalidConfig');
  // Board definitions are only trusted when they live in the registered boards folder.
  getBoardAdapter(result.data.boardId);
  const compilerOptional = result.data.boardId === 'generic' || result.data.boardId === 'auto';
  if (!compilerOptional && !result.data.toolchain.fqbn) throw new Error('error.invalidConfig');
  validatePartitions(result.data.partitions, result.data.flashSize, {
    reserveEspSystem: !compilerOptional,
  });
  return result.data;
}

/** Build inputs declared by the `be` project descriptor. */
export interface ProjectBuild {
  sketch?: string;
  files?: string[];
}

const buildSchema = z
  .object({
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
