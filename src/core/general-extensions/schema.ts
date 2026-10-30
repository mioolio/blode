import * as z from 'zod';
import { extensionPermissions } from '../../shared/general-extensions';

export const extensionId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/);
export const extensionRelative = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/[\\:\0-\x1f<>"|?*]/.test(value) &&
      !value
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[. ]$/.test(part)),
  );
const label = z.string().trim().min(1).max(120);
const icon = z
  .string()
  .max(8)
  .refine((value) => !/[<>\r\n\0]/.test(value));
const menuId = z
  .string()
  .regex(/^(?:file|edit|selection|view|goto|run|build|debug|terminal|help|extensions)$/);
const variables = z.record(
  z
    .string()
    .regex(
      /^--(?:bg(?:-deep)?|surface-[1-4]|border(?:-strong|-hover)?|text(?:-dim|-faint|-strong)?|accent(?:-strong|-soft)?|teal|green|amber|red|hover(?:-strong|-soft)?|sheen|chip-bg|popover|overlay|scroll-thumb(?:-hover)?|titlebar-[ab]|tab-active-bg|editor-bg|radius(?:-sm|-lg)?|shadow-(?:panel|pop))$/,
    ),
  z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !/[;{}<>\0\r\n]/.test(value) && !/(?:url\s*\(|expression\s*\(|@import)/i.test(value)),
);
export const appearanceSchema = z
  .object({
    variables: variables.optional(),
    background: extensionRelative.optional(),
    blur: z.number().min(0).max(32).optional(),
    translucent: z.boolean().optional(),
    menuOverrides: z
      .record(menuId, z.object({ label: label.optional(), icon: icon.optional() }).strict())
      .optional(),
  })
  .strict();
const field = z
  .object({
    id: extensionId,
    label,
    type: z.enum(['text', 'number', 'boolean', 'select']),
    default: z.union([z.string().max(2048), z.number().finite(), z.boolean()]).optional(),
    options: z
      .array(z.object({ value: z.string().max(128), label }))
      .max(64)
      .optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();
export const generalExtensionManifestSchema = z
  .object({
    apiVersion: z.literal(1),
    kind: z.literal('extension'),
    id: extensionId,
    name: label,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    description: z.string().max(1024).optional(),
    vendor: label.optional(),
    documentation: extensionRelative.optional(),
    runtime: extensionRelative.optional(),
    permissions: z.array(z.enum(extensionPermissions)).max(extensionPermissions.length),
    locales: z.record(z.string().regex(/^[a-z]{2}(?:-[A-Za-z]{2})?$/), extensionRelative).optional(),
    settings: z
      .object({ defaults: extensionRelative.optional(), fields: z.array(field).max(64) })
      .strict()
      .optional(),
    ui: z
      .object({
        menus: z
          .array(
            z
              .object({
                id: extensionId,
                label,
                labelKey: z.string().max(128).optional(),
                icon: icon.optional(),
                view: extensionId,
              })
              .strict(),
          )
          .max(32)
          .optional(),
        views: z
          .array(
            z
              .object({
                id: extensionId,
                label,
                file: extensionRelative,
                location: z.enum(['window', 'panel']),
                width: z.number().int().min(320).max(2400).optional(),
                height: z.number().int().min(240).max(1800).optional(),
              })
              .strict(),
          )
          .max(16)
          .optional(),
        appearance: appearanceSchema.optional(),
        presets: z
          .array(z.object({ id: extensionId, label, appearance: appearanceSchema }).strict())
          .max(16)
          .optional(),
        presetSetting: extensionId.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const has = (permission: (typeof extensionPermissions)[number]) =>
      manifest.permissions.includes(permission);
    const error = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(manifest.permissions).size !== manifest.permissions.length) error('Duplicate permission');
    if (manifest.runtime && (!has('native') || !/\.(?:mjs|js)$/.test(manifest.runtime)))
      error('Native runtime requires permission');
    if ((manifest.ui.appearance || manifest.ui.presets?.length) && !has('ui.appearance'))
      error('Appearance permission required');
    if (
      (manifest.ui.menus?.length ||
        manifest.ui.appearance?.menuOverrides ||
        manifest.ui.presets?.some((preset) => preset.appearance.menuOverrides)) &&
      !has('ui.menus')
    )
      error('Menu permission required');
    if (manifest.settings && !has('settings')) error('Settings permission required');
    const views = manifest.ui.views ?? [];
    if (new Set(views.map((view) => view.id)).size !== views.length) error('Duplicate view');
    if (new Set(manifest.ui.menus?.map((menu) => menu.id)).size !== (manifest.ui.menus?.length ?? 0))
      error('Duplicate menu');
    for (const view of views)
      if (!has(view.location === 'window' ? 'ui.windows' : 'ui.panels')) error('View permission required');
    for (const menu of manifest.ui.menus ?? [])
      if (!views.some((view) => view.id === menu.view)) error('Missing menu view');
    if (
      manifest.ui.presetSetting &&
      !manifest.settings?.fields.some(
        (field) => field.id === manifest.ui.presetSetting && field.type === 'select',
      )
    )
      error('Preset setting missing');
    const fields = manifest.settings?.fields ?? [];
    if (new Set(fields.map((field) => field.id)).size !== fields.length) error('Duplicate setting');
    for (const item of fields) if (item.type === 'select' && !item.options?.length) error('Missing choices');
  });
export const extensionValuesSchema = z.record(
  z.string().max(48),
  z.union([z.string().max(2048), z.number().finite(), z.boolean()]),
);
const id = z.object({ id: extensionId }).strict();
const reviewed = z
  .object({
    ticket: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirm: z.literal(true),
  })
  .strict();
const enable = id.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
  permanent: z.boolean(),
});
export const generalExtensionParameterSchemas = {
  'extensions.state': z.object({}).strict(),
  'extensions.review': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'extensions.install': reviewed,
  'extensions.enable': enable,
  'extensions.disable': id,
  'extensions.remove': id.extend({ confirm: z.literal(true) }),
  'extensions.configure': id.extend({ values: extensionValuesSchema }),
  'extensions.export': id.extend({ confirm: z.literal(true) }),
  'extensions.context': id,
  'extensions.view': id.extend({ view: extensionId }),
  'extensions.viewUrl': id.extend({ view: extensionId }),
  'extensions.openView': id.extend({ view: extensionId }),
};
