import * as z from 'zod';

const projectRoot = z.string().min(1).max(4096);
const externalId = z.string().regex(/^[a-f0-9]{32}$/);
export const languageNavigationSchema = z
  .object({
    expectedProjectRoot: projectRoot,
    requestId: externalId.optional(),
    path: z.string().min(1).max(4096),
    externalId: externalId.optional(),
    kind: z.enum(['include', 'definition', 'declaration', 'reference']),
    symbol: z
      .string()
      .regex(/^[A-Za-z_]\w{0,255}$/)
      .optional(),
    specifier: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !/[\0\r\n<>"|?*]/.test(value))
      .optional(),
  })
  .strict()
  .refine((value) => (value.kind === 'include' ? !!value.specifier : !!value.symbol));
export const languageExternalSchema = z.object({ expectedProjectRoot: projectRoot, externalId }).strict();
export const languageCancelSchema = z
  .object({ expectedProjectRoot: projectRoot, requestId: externalId })
  .strict();
export const languageParameterSchemas = {
  'language.navigate': languageNavigationSchema,
  'language.cancel': languageCancelSchema,
  'language.openExternal': languageExternalSchema,
};
