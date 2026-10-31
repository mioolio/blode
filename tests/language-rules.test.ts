import test from 'node:test';
import assert from 'node:assert/strict';
import {
  C_STANDARDS,
  analyzeCSourceRules,
  resolveCCompletionPack,
  validateProjectLanguageRules,
  type LanguageRuleFile,
} from '../extensions/completions/rules';
import { parseProjectBuild } from '../src/core/config';
import { listLanguageCompletions } from '../extensions/completions';

const custom = (file: string, body: unknown): LanguageRuleFile => ({
  path: `languages/C/c17/${file}.json`,
  content: JSON.stringify({ schemaVersion: 1, language: 'c', standard: 'c17', ...(body as object) }, null, 2),
});

test('C language standards keep isolated declaration rules without built-in completion packs', () => {
  for (const standard of C_STANDARDS) {
    const pack = resolveCCompletionPack([], standard);
    assert.deepEqual(pack.diagnostics, [], standard);
    assert.deepEqual(pack.contribution.symbols, []);
    assert.deepEqual(pack.contribution.snippets, []);
    assert.ok(
      pack.rules.some((rule) => rule.id === 'removed-gets'),
      standard,
    );
  }
  const rules = (standard: (typeof C_STANDARDS)[number]) =>
    new Set(resolveCCompletionPack([], standard).rules.map((rule) => rule.id));
  assert.equal(rules('c99').has('c11-syntax'), true);
  assert.equal(rules('c11').has('c11-syntax'), false);
  assert.equal(rules('c17').has('c23-syntax'), true);
  assert.equal(rules('c23').has('c23-syntax'), false);
  assert.deepEqual(listLanguageCompletions(), []);
});

test('selected project JSON overrides its builtin and other standard directories stay isolated', () => {
  const local = custom('p', {
    symbols: [
      { name: 'printf', kind: 'function', detail: 'board_printf(...)', insertText: 'board_printf(${1:})' },
    ],
  });
  const other = {
    ...custom('a', { symbols: [{ name: 'OTHER_STANDARD', kind: 'constant', detail: 'hidden' }] }),
    path: 'languages/C/c99/a.json',
  };
  const pack = resolveCCompletionPack([local, other], 'c17');
  assert.deepEqual(pack.diagnostics, []);
  assert.equal(pack.contribution.symbols?.filter((entry) => entry.name === 'printf').length, 1);
  assert.equal(
    pack.contribution.symbols?.find((entry) => entry.name === 'printf')?.insertText,
    'board_printf(${1:})',
  );
  assert.equal(
    pack.contribution.symbols?.some((entry) => entry.name === 'OTHER_STANDARD'),
    false,
  );
  const localOnly = resolveCCompletionPack([local], 'c17', { useBuiltins: false });
  assert.deepEqual(
    localOnly.contribution.symbols?.map((entry) => entry.name),
    ['printf'],
  );
  assert.deepEqual(localOnly.contribution.snippets, []);
});

test('malformed JSON, mixed standards, duplicate definitions and invalid semantics report paths and positions', () => {
  const badSyntax = { path: 'languages/C/c17/a.json', content: '{\n  "symbols": [' };
  const mixed = custom('b', {
    standard: 'c99',
    symbols: [{ name: 'MIXED', kind: 'constant', detail: 'mixed standard' }],
  });
  const duplicate = custom('c', {
    symbols: [
      { name: 'twice', kind: 'function', detail: 'void twice(void)' },
      { name: 'twice', kind: 'function', detail: 'void twice(int)' },
    ],
  });
  const invalid = custom('rules', {
    rules: [{ id: 'broken', kind: 'execute', names: ['danger'], severity: 'ignore', message: 'invalid' }],
  });
  const wrongLanguage = custom('d', {
    language: 'cpp',
    symbols: [{ name: 'CPP_LEAK', kind: 'constant', detail: 'not C' }],
  });
  const pack = resolveCCompletionPack([badSyntax, mixed, duplicate, invalid, wrongLanguage]);
  for (const file of [badSyntax, mixed, duplicate, invalid, wrongLanguage])
    assert.ok(
      pack.diagnostics.some(
        (item) => item.file === file.path && item.severity === 'error' && item.line >= 1 && item.column >= 1,
      ),
      file.path,
    );
  assert.equal(
    pack.contribution.symbols?.some((entry) => ['MIXED', 'CPP_LEAK'].includes(entry.name)),
    false,
  );
  assert.ok(pack.diagnostics.some((item) => item.file === duplicate.path && item.line > 1));
});

test('declarative source diagnostics skip comments and literals and preserve source coordinates', () => {
  const files = [
    custom('rules', {
      rules: [
        {
          id: 'board-no-delay',
          kind: 'call',
          names: ['busy_delay'],
          severity: 'warning',
          message: 'Use the scheduler.',
          enabled: true,
        },
      ],
    }),
    {
      path: 'src/main.c',
      content: '// busy_delay(1);\nchar *s = "busy_delay(2)";\nvoid run(void) { busy_delay(3); }\n',
    },
  ];
  const diagnostics = analyzeCSourceRules(files, 'c17');
  assert.deepEqual(
    diagnostics.map((item) => [item.file, item.line, item.column, item.severity]),
    [['src/main.c', 3, 18, 'warning']],
  );
  const disabled = custom('rules', {
    rules: [
      {
        id: 'removed-gets',
        kind: 'call',
        names: ['gets'],
        severity: 'warning',
        message: 'disabled',
        enabled: false,
      },
    ],
  });
  assert.deepEqual(
    analyzeCSourceRules([disabled, { path: 'main.c', content: 'void f(void) { gets(buffer); }' }]),
    [],
  );
});

test('build C standard is explicit and rejects unknown dialects while legacy Arduino remains available', () => {
  assert.equal(parseProjectBuild({ cStandard: 'c99', entry: 'main.c' }).cStandard, 'c99');
  assert.throws(() => parseProjectBuild({ cStandard: 'c21' }), /error.invalidProjectDescriptor/);
  assert.equal(parseProjectBuild({}).cStandard, undefined);
  assert.deepEqual(listLanguageCompletions(), []);
  assert.deepEqual(validateProjectLanguageRules([], 'c17'), []);
});

test('legacy custom catalog syntax is diagnosed and C checks do not run on C++ headers', () => {
  const invalid = { path: 'blode.completions.json', content: '{"c": [' };
  assert.equal(validateProjectLanguageRules([invalid])[0]?.file, invalid.path);
  const files = [
    { path: 'main.cpp', content: '#include "check.h"' },
    { path: 'check.h', content: 'static_assert(true, "ok");' },
  ];
  assert.deepEqual(analyzeCSourceRules(files, 'c17'), []);
});
