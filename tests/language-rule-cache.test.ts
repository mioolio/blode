import test from 'node:test';
import assert from 'node:assert/strict';
import { LanguageRuleCache } from '../src/renderer/editor/languageRuleCache';
import { analyzeCSourceRules, type LanguageRuleFile } from '../extensions/completions/rules';
import { resolveCCompletionCatalog } from '../src/shared/c-completion-catalog';

const ruleFile = (message = 'Use new_call') => ({
  path: 'languages/C/c17/rules.json',
  content: JSON.stringify({
    schemaVersion: 1,
    language: 'c',
    standard: 'c17',
    rules: [{ id: 'old-call', kind: 'call', names: ['OLD'], severity: 'warning', message }],
  }),
});

test('ordinary source edits reuse parsed rule JSON and never scan unopened buffers', () => {
  const calls: string[][] = [];
  const cache = new LanguageRuleCache((files, standard, options) => {
    calls.push(files.map((file) => file.path));
    return analyzeCSourceRules(files, standard, options);
  });
  let files: LanguageRuleFile[] = [
    ruleFile(),
    { path: 'main.c', content: 'void main(void) { OLD(); }' },
    { path: 'visible.c', content: 'void other(void) { OLD(); }' },
    { path: 'unopened.c', content: 'void untouched(void) { OLD(); }' },
  ];
  cache.update(files, 'c17', true, '/project');
  const pack = cache.pack();
  assert.equal(cache.diagnostics('main.c')[0]?.message, 'Use new_call');
  const visible = cache.diagnostics('visible.c');
  assert.deepEqual(calls, [['main.c'], ['visible.c']]);
  files = files.map((file) =>
    file.path === 'main.c' ? { ...file, content: 'void main(void) { int n = 1; OLD(); }' } : { ...file },
  );
  cache.update(files, 'c17', true, '/project');
  assert.equal(cache.pack(), pack, 'a C keystroke must not rebuild the completion/rule pack');
  assert.equal(
    cache.diagnostics('visible.c'),
    visible,
    'another visible model reuses its source diagnostics',
  );
  assert.equal(cache.diagnostics('main.c')[0]?.column, files[1].content.indexOf('OLD') + 1);
  assert.deepEqual(calls, [['main.c'], ['visible.c'], ['main.c']]);
  files[0] = ruleFile('Updated rule');
  cache.update(files, 'c17', true, '/project');
  assert.notEqual(cache.pack(), pack, 'JSON edits invalidate the configured pack');
  assert.equal(cache.diagnostics('main.c')[0]?.message, 'Updated rule');
  assert.ok(!calls.some((paths) => paths.includes('unopened.c')));
});

test('standard, builtin preference, project and mixed-language changes invalidate only relevant caches', () => {
  let scans = 0;
  const cache = new LanguageRuleCache((files, standard, options) => {
    scans++;
    return analyzeCSourceRules(files, standard, options);
  });
  const files = [{ path: 'api.h', content: 'void f(void) { static_assert(1); }' }];
  cache.update(files, 'c17', true, '/one');
  const pack = cache.pack();
  assert.ok(cache.diagnostics('api.h').length);
  cache.update([...files, { path: 'main.cpp', content: '' }], 'c17', true, '/one');
  assert.equal(cache.pack(), pack, 'adding C++ does not reparse JSON');
  assert.deepEqual(cache.diagnostics('api.h'), [], 'ambiguous C++ headers are not checked as C');
  assert.equal(scans, 1);
  cache.update(files, 'c23', true, '/one');
  assert.notEqual(cache.pack(), pack);
  assert.deepEqual(cache.diagnostics('api.h'), []);
  cache.update(files, 'c23', false, '/one');
  assert.ok(!cache.pack().contribution.symbols?.some((entry) => entry.name === 'printf'));
  cache.update(files, 'c23', false, '/two');
  cache.diagnostics('api.h');
  assert.equal(scans, 3, 'switching project cannot reuse source diagnostics from the prior workspace');
});

test('C catalog applies cpp compatibility overrides before explicit c entries and retains owner groups', () => {
  const result = resolveCCompletionCatalog(
    {
      language: 'cpp',
      symbols: [{ name: 'printf', kind: 'function', detail: 'C17 printf' }],
      snippets: [{ name: 'loop', kind: 'snippet', detail: 'C loop' }],
    },
    [{ name: 'board_init', kind: 'function', detail: 'workspace definition' }],
    [
      { language: 'c', name: 'printf', kind: 'function', detail: 'C override' },
      { language: 'cpp', name: 'printf', kind: 'function', detail: 'compatibility override' },
      { language: 'c', name: 'board_init', kind: 'function', detail: '', disabled: true },
      { language: 'cpp', name: 'loop', kind: 'snippet', detail: '', disabled: true },
      { language: 'cpp', owner: 'meter', name: 'read', kind: 'method', detail: 'compat read' },
      { language: 'c', owner: 'meter', name: 'read', kind: 'method', detail: 'C read' },
      { language: 'java', name: 'unrelated', kind: 'method', detail: 'Java method' },
    ],
  );
  assert.equal(result.symbols?.find((entry) => entry.name === 'printf')?.detail, 'C override');
  assert.ok(!result.symbols?.some((entry) => entry.name === 'board_init'));
  assert.ok(!result.snippets?.some((entry) => entry.name === 'loop'));
  assert.ok(!result.symbols?.some((entry) => entry.name === 'unrelated'));
  assert.equal(result.members?.find((group) => group.owner === 'meter')?.members[0]?.detail, 'C read');
});
