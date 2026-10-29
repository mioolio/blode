import * as z from 'zod';
import type { RuntimePluginManifest } from '../shared/plugins';
import { configSchema } from './config';
import { moduleLanguagesSchema } from '../shared/module-languages';

const text = z.string().trim().min(1).max(4096);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const relative = text.refine(
  (value) =>
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((part) => part === '..' || part === '.' || !part) &&
    !/[\0\r\n:]/.test(value),
);
const size = z.number().int().nonnegative().max(0xffffffff);
const fieldSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(128),
    type: z.enum(['text', 'number', 'boolean', 'select']),
    default: z.union([z.string().max(4096), z.number().finite(), z.boolean()]).optional(),
    options: z
      .array(z.object({ value: z.string().max(1024), label: z.string().min(1).max(128) }).strict())
      .max(200)
      .optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.min !== undefined && field.max !== undefined && field.min > field.max)
      context.addIssue({ code: 'custom', message: 'field limits' });
    if (
      field.type === 'select' &&
      (!field.options?.length ||
        new Set(field.options.map((option) => option.value)).size !== field.options.length)
    )
      context.addIssue({ code: 'custom', message: 'select options' });
    if (
      field.default !== undefined &&
      ((field.type === 'boolean' && typeof field.default !== 'boolean') ||
        (field.type === 'number' && typeof field.default !== 'number') ||
        (['text', 'select'].includes(field.type) && typeof field.default !== 'string'))
    )
      context.addIssue({ code: 'custom', message: 'field default' });
    if (
      field.type === 'select' &&
      field.default !== undefined &&
      !field.options?.some((option) => option.value === field.default)
    )
      context.addIssue({ code: 'custom', message: 'select default' });
  });
export const runtimePluginManifestSchema = z
  .object({
    apiVersion: z.literal(2),
    runtimeApiVersion: z.literal(2),
    kind: z.literal('board'),
    id,
    name: z.string().trim().min(1).max(128),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    runtime: relative.refine((value) => /\.(?:mjs|cjs)$/.test(value)),
    vendor: text.optional(),
    description: text.optional(),
    descriptionKey: text.optional(),
    documentation: z.url().optional(),
    transport: z.enum(['serial', 'stlink', 'usb', 'physical', 'custom']),
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(64),
    sourceInputs: z.array(relative).max(200).optional(),
    languages: moduleLanguagesSchema.optional(),
    support: z
      .object({
        chips: z.array(text).min(1).max(200),
        families: z.array(text).max(50).optional(),
        status: z.enum(['experimental', 'supported']),
        notes: text.optional(),
      })
      .strict(),
    defaultConfig: configSchema,
    compiler: z
      .object({
        mode: z.enum(['host', 'plugin', 'runtime']),
        baseRuntime: id.optional(),
        managedTools: z
          .array(z.object({ id, name: text, version: text.optional() }).strict())
          .min(1)
          .max(32)
          .optional(),
        defaultTool: z
          .object({
            id,
            executable: relative,
            runner: z.enum(['native', 'node']).optional(),
            version: text.optional(),
            args: z.array(z.string().max(4096)).max(100).optional(),
          })
          .strict()
          .optional(),
        forceComponent: z.boolean().optional(),
      })
      .strict(),
    debugger: z
      .object({
        mode: z.enum(['none', 'builtin', 'extend', 'replace']),
        view: relative.refine((value) => /\.html?$/.test(value)).optional(),
      })
      .strict(),
    layout: z
      .object({
        flashBaseAddress: size.optional(),
        recommendedFlashSizes: z.array(size).max(100),
        possibleFlashSizes: z.array(size).max(100).optional(),
        ramSize: size,
      })
      .strict(),
    constraints: z
      .object({
        chipIds: z
          .array(z.string().regex(/^0x[0-9a-fA-F]+$/))
          .max(100)
          .optional(),
        notes: z.array(text).max(100).optional(),
      })
      .strict(),
    ui: z
      .object({
        views: z
          .array(
            z
              .object({
                id,
                label: z.string().min(1).max(80),
                file: relative.refine((value) => /\.html?$/.test(value)),
                location: z.enum(['window', 'panel']),
                width: z.number().int().min(320).max(3840).optional(),
                height: z.number().int().min(240).max(2160).optional(),
              })
              .strict(),
          )
          .max(32)
          .optional(),
        fields: z.array(fieldSchema).max(64),
        actions: z
          .array(
            z.object({ id, label: z.string().min(1).max(128), confirm: z.boolean().optional() }).strict(),
          )
          .max(64)
          .optional(),
        hiddenCapabilities: z.array(text).max(64).optional(),
        view: relative.refine((value) => /\.html?$/.test(value)).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.ui.views?.map((view) => view.id)).size !== (manifest.ui.views?.length ?? 0))
      context.addIssue({ code: 'custom', message: 'duplicate view ids' });
    if (manifest.defaultConfig.boardId !== manifest.id)
      context.addIssue({ code: 'custom', message: 'boardId must match id' });
    if (manifest.compiler.mode === 'host' && !manifest.compiler.baseRuntime)
      context.addIssue({ code: 'custom', message: 'host compiler baseRuntime required' });
    if (manifest.compiler.mode === 'runtime' && !manifest.compiler.managedTools?.length)
      context.addIssue({ code: 'custom', message: 'runtime compiler managedTools required' });
    if (
      manifest.compiler.managedTools &&
      new Set(manifest.compiler.managedTools.map((tool) => tool.id)).size !==
        manifest.compiler.managedTools.length
    )
      context.addIssue({ code: 'custom', message: 'duplicate managed tool ids' });
    if (
      (manifest.compiler.mode === 'plugin' || manifest.compiler.forceComponent) &&
      !manifest.compiler.defaultTool
    )
      context.addIssue({ code: 'custom', message: 'plugin compiler defaultTool required' });
    if (new Set(manifest.ui.fields.map((field) => field.id)).size !== manifest.ui.fields.length)
      context.addIssue({ code: 'custom', message: 'duplicate fields' });
    if (
      new Set(manifest.ui.actions?.map((action) => action.id)).size !== manifest.ui.actions?.length &&
      manifest.ui.actions
    )
      context.addIssue({ code: 'custom', message: 'duplicate actions' });
  });
export function parseRuntimePluginManifest(value: unknown): RuntimePluginManifest {
  const parsed = runtimePluginManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error('error.runtimePluginManifest');
  return parsed.data as RuntimePluginManifest;
}
