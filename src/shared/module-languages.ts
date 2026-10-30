import * as z from 'zod';
import type { LanguageCompletions } from '../../extensions/completions/types';
import {
  analyzeCSourceRules,
  resolveCCompletionPack,
  type CStandard,
  type SourceRule,
  type LanguageRuleDiagnostic,
  type LanguageRuleFile,
} from '../../extensions/completions/rules';

const languageId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const catalogPath = z
  .string()
  .max(1024)
  .regex(/^languages\/(?:[A-Za-z0-9_+.-]+\/)*[A-Za-z0-9_-]+\.json$/)
  .refine((value) => !value.split('/').some((part) => part === '.' || part === '..'));
export const moduleLanguagesSchema = z
  .object({
    mode: z.enum(['fixed', 'declared']),
    default: languageId,
    entries: z
      .array(
        z
          .object({
            id: languageId,
            editorLanguage: languageId,
            extensions: z
              .array(z.string().regex(/^\.[a-z0-9_+-]{1,16}$/))
              .min(1)
              .max(32),
            catalogs: z.array(catalogPath).max(64),
            standards: z
              .object({
                c99: z.array(catalogPath).max(64).optional(),
                c11: z.array(catalogPath).max(64).optional(),
                c17: z.array(catalogPath).max(64).optional(),
                c23: z.array(catalogPath).max(64).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'fixed' && value.entries.length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'fixed mode requires exactly one language',
      });
    if (!value.entries.some((entry) => entry.id === value.default))
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'default language is not declared' });
    if (new Set(value.entries.map((entry) => entry.id)).size !== value.entries.length)
      ctx.addIssue({ code: 'custom', path: ['entries'], message: 'duplicate language id' });
    const extensions = value.entries.flatMap((entry) => entry.extensions);
    if (new Set(extensions).size !== extensions.length)
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'file extensions must belong to one language',
      });
  });
export type ModuleLanguagesDeclaration = z.infer<typeof moduleLanguagesSchema>;
const completion = z
  .object({
    name: z.string().min(1).max(128),
    kind: z.enum(['function', 'method', 'variable', 'constant', 'type', 'keyword', 'snippet', 'property']),
    detail: z.string().max(1024),
    documentation: z.string().max(8192).optional(),
    insertText: z.string().max(16384).optional(),
    sortText: z.string().max(128).optional(),
  })
  .strict();
const sourceRule = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    kind: z.enum(['call', 'token']),
    names: z
      .array(z.string().regex(/^[A-Za-z_]\w*$/))
      .min(1)
      .max(128),
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1).max(1024),
    enabled: z.boolean().default(true),
  })
  .strict();
export const moduleLanguageCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    language: languageId,
    triggerCharacters: z.array(z.string().min(1).max(2)).max(32).optional(),
    symbols: z.array(completion).max(4096).optional(),
    snippets: z.array(completion).max(4096).optional(),
    members: z
      .array(
        z
          .object({
            owner: z.string().regex(/^[A-Za-z_]\w*(?:::\w+)*$/),
            members: z.array(completion).max(2048),
          })
          .strict(),
      )
      .max(256)
      .optional(),
    rules: z.array(sourceRule).max(256).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rules?.length && !['c', 'cpp'].includes(value.language))
      context.addIssue({
        code: 'custom',
        path: ['rules'],
        message:
          'Token/call semantic rules currently support c/cpp only; other languages may declare completions.',
      });
  });
export interface ModuleLanguageEntry {
  id: string;
  editorLanguage: string;
  extensions: string[];
  contributions: LanguageCompletions[];
  /** Workspace-authored additions remain enabled when built-in suggestions are hidden. */
  userContributions?: LanguageCompletions[];
  rules: SourceRule[];
}
export interface ModuleLanguageState {
  moduleId: string;
  mode: 'fixed' | 'declared';
  default: string;
  entries: ModuleLanguageEntry[];
  diagnostics: LanguageRuleDiagnostic[];
}
export function moduleLanguagePaths(declaration: ModuleLanguagesDeclaration, standard: string): string[] {
  return [
    ...new Set(
      declaration.entries.flatMap((entry) => [
        ...entry.catalogs,
        ...(entry.standards?.[standard as keyof typeof entry.standards] ?? []),
      ]),
    ),
  ];
}
export function resolveModuleLanguages(
  moduleId: string,
  declaration: ModuleLanguagesDeclaration,
  assets: Record<string, unknown>,
  standard: string,
): ModuleLanguageState {
  const state: ModuleLanguageState = {
    moduleId,
    mode: declaration.mode,
    default: declaration.default,
    entries: [],
    diagnostics: [],
  };
  for (const entry of declaration.entries) {
    const resolved: ModuleLanguageEntry = {
      id: entry.id,
      editorLanguage: entry.editorLanguage,
      extensions: entry.extensions,
      contributions: [],
      rules: [],
    };
    state.entries.push(resolved);
    const files = [...entry.catalogs];
    if (entry.standards) {
      const paths = entry.standards[standard as keyof typeof entry.standards];
      if (!paths)
        state.diagnostics.push({
          file: `${moduleId}/manifest.json`,
          line: 1,
          column: 1,
          severity: 'error',
          message: `Language ${entry.id} does not declare ${standard}.`,
        });
      else files.push(...paths);
    }
    for (const file of new Set(files)) {
      const value = assets[file];
      const parsed = moduleLanguageCatalogSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues.slice(0, 20))
          state.diagnostics.push({
            file: `${moduleId}/${file}`,
            line: 1,
            column: 1,
            severity: 'error',
            message: `${issue.path.join('.') || 'catalog'}: ${issue.message}`,
          });
        continue;
      }
      if (parsed.data.language !== entry.editorLanguage) {
        state.diagnostics.push({
          file: `${moduleId}/${file}`,
          line: 1,
          column: 1,
          severity: 'error',
          message: `language must be ${entry.editorLanguage}.`,
        });
        continue;
      }
      const { schemaVersion: _, rules, ...contribution } = parsed.data;
      resolved.contributions.push(contribution);
      resolved.rules.push(...(rules ?? []));
    }
  }
  return state;
}
export function moduleLanguageForFile(
  state: ModuleLanguageState,
  path: string,
): ModuleLanguageEntry | undefined {
  const extension = /\.[^./\\]+$/.exec(path.toLowerCase())?.[0];
  return state.entries.find((entry) => entry.extensions.includes(extension ?? ''));
}
export function analyzeModuleLanguageRules(
  state: ModuleLanguageState,
  files: readonly LanguageRuleFile[],
): LanguageRuleDiagnostic[] {
  const result: LanguageRuleDiagnostic[] = [];
  for (const file of files) {
    const entry = moduleLanguageForFile(state, file.path);
    if (!entry?.rules.length) continue;
    // The declared C/C++ token/call rules share one lexer and retain source positions.
    result.push(
      ...analyzeCSourceRules([{ ...file, path: `${file.path}.c` }], 'c17', {
        mixedCpp: false,
        pack: { contribution: { language: entry.editorLanguage }, rules: entry.rules, diagnostics: [] },
      }).map((diagnostic) => ({ ...diagnostic, file: file.path })),
    );
    if (result.length >= 500) break;
  }
  return result.slice(0, 500);
}

/** Workspace overrides stay project-local and inherit only the selected module. */
export function withModuleLanguageOverrides(
  state: ModuleLanguageState,
  files: readonly LanguageRuleFile[],
  standard: CStandard,
): ModuleLanguageState {
  if (!state.entries.some((entry) => entry.id === 'c')) return state;
  const custom = resolveCCompletionPack(files, standard, { useBuiltins: false, useBuiltinRules: false });
  return {
    ...state,
    diagnostics: [...state.diagnostics, ...custom.diagnostics],
    entries: state.entries.map((entry) =>
      entry.id !== 'c'
        ? entry
        : {
            ...entry,
            userContributions: [{ ...custom.contribution, language: entry.editorLanguage }],
            rules: [...new Map([...entry.rules, ...custom.rules].map((rule) => [rule.id, rule])).values()],
          },
    ),
  };
}
