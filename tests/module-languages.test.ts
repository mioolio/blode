import test from 'node:test';
import assert from 'node:assert/strict';
import { getBoardAdapter } from '../extensions/registry';
import {
  moduleLanguagesSchema,
  moduleLanguageForFile,
  resolveModuleLanguages,
  analyzeModuleLanguageRules,
  withModuleLanguageOverrides,
  type ModuleLanguagesDeclaration,
} from '../src/shared/module-languages';
import { resolveCCompletionPack } from '../extensions/completions/rules';
import {
  registerCompletions,
  setCompletionProject,
  setCompletionCatalog,
} from '../src/renderer/editor/completionProvider';
import { ModuleLanguageCache } from '../src/renderer/editor/moduleLanguageCache';

const declaration: ModuleLanguagesDeclaration = {
  mode: 'fixed',
  default: 'c',
  entries: [
    { id: 'c', editorLanguage: 'cpp', extensions: ['.c', '.h'], catalogs: ['languages/C/catalog.json'] },
  ],
};
const catalog = {
  schemaVersion: 1,
  language: 'cpp',
  symbols: [{ name: 'module_only', kind: 'function', detail: 'void module_only(void)' }],
  rules: [
    {
      id: 'forbid-module-call',
      kind: 'call',
      names: ['dangerous'],
      severity: 'error',
      message: 'Use safe_call',
    },
  ],
};
const resolve = () =>
  resolveModuleLanguages('Custom', declaration, { 'languages/C/catalog.json': catalog }, 'c17');

test('language declarations enforce fixed/list distinction, unique extensions and module-local catalog paths', () => {
  assert.equal(moduleLanguagesSchema.safeParse(declaration).success, true);
  for (const invalid of [
    {
      ...declaration,
      entries: [...declaration.entries, { ...declaration.entries[0], id: 'cpp', extensions: ['.cpp'] }],
    },
    { ...declaration, default: 'java' },
    { ...declaration, entries: [{ ...declaration.entries[0], catalogs: ['../global.json'] }] },
    {
      mode: 'declared',
      default: 'c',
      entries: [declaration.entries[0], { ...declaration.entries[0], id: 'cpp' }],
    },
  ])
    assert.equal(moduleLanguagesSchema.safeParse(invalid).success, false);
});

test('module language rules are scoped by declared extensions and never inherit host defaults', () => {
  const state = resolve();
  assert.equal(state.diagnostics.length, 0);
  assert.equal(moduleLanguageForFile(state, 'main.c')?.id, 'c');
  assert.equal(moduleLanguageForFile(state, 'other.cpp'), undefined);
  const diagnostics = analyzeModuleLanguageRules(state, [
    { path: 'main.c', content: 'dangerous(); gets(buf);' },
    { path: 'other.cpp', content: 'dangerous();' },
  ]);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.file, entry.rule]),
    [['main.c', 'forbid-module-call']],
  );
  const customOnly = resolveCCompletionPack([], 'c17', { useBuiltins: false, useBuiltinRules: false });
  assert.deepEqual(customOnly.rules, []);
  assert.deepEqual(customOnly.contribution.symbols, []);
});

test('workspace language overrides extend only their module catalog and rules', () => {
  const state = withModuleLanguageOverrides(
    resolve(),
    [
      {
        path: 'languages/C/c17/rules.json',
        content: JSON.stringify({
          schemaVersion: 1,
          language: 'c',
          standard: 'c17',
          rules: [
            {
              id: 'forbid-module-call',
              kind: 'call',
              names: ['dangerous'],
              severity: 'error',
              message: 'User override',
              enabled: false,
            },
          ],
        }),
      },
    ],
    'c17',
  );
  assert.equal(state.diagnostics.length, 0);
  assert.deepEqual(
    analyzeModuleLanguageRules(state, [{ path: 'main.c', content: 'dangerous(); gets(buf);' }]),
    [],
  );
});

test('builtin modules carry independent C standard catalogs and ESP-only Arduino completions', () => {
  for (const id of ['STM32F103C8T6', 'Esp32_S3_CAM']) {
    const adapter = getBoardAdapter(id);
    for (const standard of ['c99', 'c11', 'c17', 'c23']) {
      const state = resolveModuleLanguages(
        id,
        adapter.definition.runtimePlugin!.languages!,
        adapter.languageAssets!,
        standard,
      );
      assert.deepEqual(state.diagnostics, []);
      const c = state.entries.find((entry) => entry.id === 'c')!;
      assert.equal(c.contributions.length, 1);
      assert.ok(c.contributions[0].symbols!.some((entry) => entry.name === 'printf'));
      const cpp = state.entries.find((entry) => entry.id === 'cpp')!;
      assert.equal(
        cpp.contributions.some((pack) => pack.symbols?.some((entry) => entry.name === 'digitalWrite')),
        id === 'Esp32_S3_CAM',
      );
    }
  }
});

test('invalid module JSON values and unsupported standards produce file/property diagnostics', () => {
  const invalid = resolveModuleLanguages(
    'Custom',
    declaration,
    { 'languages/C/catalog.json': { ...catalog, symbols: [{ name: 'bad', kind: 'invented' }] } },
    'c17',
  );
  assert.ok(
    invalid.diagnostics.some(
      (entry) => entry.file === 'Custom/languages/C/catalog.json' && entry.message.includes('symbols.0'),
    ),
  );
  const versioned = {
    ...declaration,
    entries: [
      { ...declaration.entries[0], catalogs: [], standards: { c99: ['languages/C/c99/catalog.json'] } },
    ],
  };
  assert.ok(
    resolveModuleLanguages('Custom', versioned, {}, 'c17').diagnostics.some((entry) =>
      entry.message.includes('c17'),
    ),
  );
});

test('other language completions are allowed but C lexer rules are not silently applied to them', () => {
  const python: ModuleLanguagesDeclaration = {
    mode: 'fixed',
    default: 'python',
    entries: [
      {
        id: 'python',
        editorLanguage: 'python',
        extensions: ['.py'],
        catalogs: ['languages/Python/catalog.json'],
      },
    ],
  };
  const assets = {
    'languages/Python/catalog.json': {
      schemaVersion: 1,
      language: 'python',
      symbols: [{ name: 'module_function', kind: 'function', detail: 'def module_function()' }],
    },
  };
  assert.equal(resolveModuleLanguages('Python', python, assets, 'c17').diagnostics.length, 0);
  const withRules = resolveModuleLanguages(
    'Python',
    python,
    { 'languages/Python/catalog.json': { ...assets['languages/Python/catalog.json'], rules: catalog.rules } },
    'c17',
  );
  assert.ok(withRules.diagnostics.some((issue) => issue.message.includes('c/cpp only')));
  assert.deepEqual(
    analyzeModuleLanguageRules(withRules, [{ path: 'test.py', content: '# dangerous()' }]),
    [],
  );
});

test('Monaco uses the module catalog without leaking global Arduino/C entries, while retaining local symbols and user entries', () => {
  const providers = new Map<string, Set<any>>();
  const disposable = () => ({ dispose() {} });
  const monaco = {
    Range: class {
      constructor(..._args: unknown[]) {}
    },
    editor: { getModels: () => [], onDidCreateModel: disposable },
    languages: {
      CompletionItemKind: {},
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider(language: string, provider: unknown) {
        const set = providers.get(language) ?? new Set();
        providers.set(language, set);
        set.add(provider);
        return { dispose: () => set.delete(provider) };
      },
      registerHoverProvider: disposable,
      registerDefinitionProvider: disposable,
      registerDeclarationProvider: disposable,
      registerLinkProvider: disposable,
      registerReferenceProvider: disposable,
    },
  } as any;
  setCompletionCatalog({
    useBuiltins: true,
    entries: [{ language: 'c', name: 'user_only', kind: 'function', detail: 'User entry' }],
  });
  setCompletionProject([{ path: 'main.c', content: 'void local_symbol(void) {}' }], {
    language: resolve(),
    projectRoot: '/workspace',
  });
  registerCompletions(monaco);
  const model = {
    uri: { path: '/workspace/main.c' },
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }),
    getValueInRange: () => '',
  } as any;
  const names = [...providers.get('cpp')!].flatMap((provider) =>
    provider
      .provideCompletionItems(model, { lineNumber: 1, column: 1 })
      .suggestions.map((item: any) => item.label),
  );
  for (const name of ['module_only', 'local_symbol', 'user_only']) assert.ok(names.includes(name), name);
  for (const name of ['digitalWrite', 'printf']) assert.equal(names.includes(name), false, name);
  setCompletionCatalog({
    useBuiltins: false,
    entries: [{ language: 'c', name: 'user_only', kind: 'function', detail: 'User entry' }],
  });
  setCompletionProject(
    [
      { path: 'main.c', content: 'void local_symbol(void) {}' },
      {
        path: 'languages/C/c17/user.json',
        content: JSON.stringify({
          schemaVersion: 1,
          language: 'c',
          standard: 'c17',
          symbols: [{ name: 'project_only', kind: 'function', detail: 'Project entry' }],
        }),
      },
    ],
    { language: resolve(), projectRoot: '/workspace' },
  );
  const customNames = [...providers.get('cpp')!].flatMap((provider) =>
    provider
      .provideCompletionItems(model, { lineNumber: 1, column: 1 })
      .suggestions.map((item: any) => item.label),
  );
  for (const name of ['project_only', 'user_only', 'local_symbol'])
    assert.ok(customNames.includes(name), name);
  assert.equal(customNames.includes('module_only'), false);
  const python: ModuleLanguagesDeclaration = {
    mode: 'fixed',
    default: 'python',
    entries: [
      {
        id: 'python',
        editorLanguage: 'python',
        extensions: ['.py'],
        catalogs: ['languages/Python/catalog.json'],
      },
    ],
  };
  setCompletionProject([{ path: 'main.py', content: '' }], {
    projectRoot: '/workspace',
    language: resolveModuleLanguages(
      'Python',
      python,
      {
        'languages/Python/catalog.json': {
          schemaVersion: 1,
          language: 'python',
          triggerCharacters: [':'],
          symbols: [{ name: 'function', kind: 'keyword', detail: 'function' }],
        },
      },
      'c17',
    ),
  });
  assert.ok([...providers.get('python')!].some((provider) => provider.triggerCharacters.includes(':')));
  setCompletionProject([], {});
  setCompletionCatalog({ useBuiltins: true, entries: [] });
});

test('typing does not reparse or stringify unchanged module and workspace catalogs', () => {
  let calls = 0;
  const cache = new ModuleLanguageCache((...args) => {
    calls++;
    return withModuleLanguageOverrides(...args);
  });
  const language = resolve();
  const initial = cache.update(language, [{ path: 'main.c', content: '' }], 'c17');
  assert.equal(cache.update(language, [{ path: 'main.c', content: 'void main(){}' }], 'c17'), initial);
  assert.equal(
    cache.update(structuredClone(language), [{ path: 'main.c', content: 'void main(){ int a; }' }], 'c17'),
    initial,
  );
  assert.equal(calls, 1);
  const changed = cache.update(language, [{ path: 'languages/C/c17/user.json', content: '{ broken' }], 'c17');
  assert.notEqual(changed, initial);
  assert.ok(changed.state!.diagnostics.length);
  assert.equal(calls, 2);
});
