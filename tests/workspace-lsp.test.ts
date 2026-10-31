import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCompletions,
  setCompletionCatalog,
  setCompletionProject,
} from '../src/renderer/editor/completionProvider';

const projectRoot = '/workspace';
const providers = new Map<string, Set<any>>();
const hovers = new Map<string, Set<any>>();
const disposable = () => ({ dispose() {} });
const requests: any[] = [];
const notifications: any[] = [];
const lspItems = [
  {
    label: 'draft_symbol',
    kind: 3,
    detail: 'void draft_symbol(void)',
    insertText: 'draft_symbol(${1:})',
    insertTextFormat: 2,
    range: { start: { line: 0, character: 5 }, end: { line: 0, character: 17 } },
  },
  {
    label: 'saved',
    kind: 3,
    detail: 'void saved(void) — host',
    insertText: 'saved(${1:})',
    insertTextFormat: 2,
  },
];

let version = 1;
let text = 'void draft_symbol(void) {}\n';
const lines = () => text.split('\n');
const model = {
  uri: { path: `${projectRoot}/main.c` },
  getVersionId: () => version,
  getValue: () => text,
  getLanguageId: () => 'c',
  isDisposed: () => false,
  getWordUntilPosition: (position: any) => {
    const line = lines()[position.lineNumber - 1] ?? '';
    const before = line.slice(0, position.column - 1);
    const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? '';
    return { word, startColumn: position.column - word.length, endColumn: position.column };
  },
  getValueInRange: (range: any) => {
    const line = lines()[range.startLineNumber - 1] ?? '';
    return line.slice(range.startColumn - 1, range.endColumn - 1);
  },
  getWordAtPosition: (position: any) => {
    const line = lines()[position.lineNumber - 1] ?? '';
    const index = position.column - 1;
    let start = index;
    let end = index;
    if (start > 0 && !/[A-Za-z0-9_]/.test(line[start] ?? '') && /[A-Za-z0-9_]/.test(line[start - 1] ?? ''))
      start -= 1;
    while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start--;
    while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end++;
    const word = line.slice(start, end);
    return /^[A-Za-z_]\w*$/.test(word) ? { word, startColumn: start + 1, endColumn: end + 1 } : null;
  },
};

const monaco = {
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
  Uri: { file: (path: string) => ({ path, toString: () => 'file://' + path }) },
  MarkerSeverity: { Error: 8, Warning: 4 },
  editor: {
    getModels: () => [model],
    setModelMarkers: () => {},
    onDidCreateModel: disposable,
  },
  languages: {
    CompletionItemKind: {},
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider(language: string, provider: any) {
      const set = providers.get(language) ?? new Set();
      providers.set(language, set);
      set.add(provider);
      return { dispose: () => set.delete(provider) };
    },
    registerHoverProvider(language: string, provider: any) {
      const set = hovers.get(language) ?? new Set();
      hovers.set(language, set);
      set.add(provider);
      return { dispose: () => set.delete(provider) };
    },
    registerDefinitionProvider: disposable,
    registerDeclarationProvider: disposable,
    registerLinkProvider: disposable,
    registerReferenceProvider: disposable,
  },
} as any;

function installBridge(withLsp = true) {
  const blode: any = {
    languageNavigate: async () => [],
    languageOpenExternal: async () => {
      throw new Error('error.languageSourceExpired');
    },
  };
  if (withLsp) {
    blode.languageLspRequest = async (request: any) => {
      requests.push(request);
      if (request.method === 'initialize') return { serverInfo: { name: 'test' }, capabilities: {} };
      if (request.method === 'textDocument/completion') return { isIncomplete: false, items: lspItems };
      if (request.method === 'textDocument/hover')
        return { contents: { kind: 'markdown', value: '```c\nvoid draft_symbol(void)\n```' } };
      return null;
    };
    blode.languageLspNotify = async (batch: any) => {
      notifications.push(batch);
    };
  }
  (globalThis as any).window = { blode };
}

async function completionNames() {
  const responses = await Promise.all(
    [...providers.get('cpp')!].map((provider) =>
      Promise.resolve(provider.provideCompletionItems(model, { lineNumber: 1, column: 1 })),
    ),
  );
  return responses.flatMap((response: any) =>
    response.suggestions.map((item: any) => ({
      label: typeof item.label === 'string' ? item.label : item.label.label,
      detail: item.detail,
      insertText: item.insertText,
      rules: item.insertTextRules,
      range: item.range,
    })),
  );
}

test('completion is answered by the host language service and synchronises documents', async () => {
  installBridge();
  setCompletionCatalog({ useBuiltins: false, entries: [] });
  setCompletionProject([{ path: 'main.c', content: 'void saved(void) {}' }], { projectRoot });
  registerCompletions(monaco);

  const suggestions = await completionNames();
  const names = suggestions.map((item) => item.label);
  assert.ok(names.includes('draft_symbol'), names.join(','));
  assert.equal(names.filter((name) => name === 'saved').length, 1, 'LSP result wins over the local fallback');
  const saved = suggestions.find((item) => item.label === 'saved')!;
  assert.equal(saved.detail, 'void saved(void) — host');
  assert.equal(saved.rules, 4, 'LSP snippet format maps to Monaco InsertAsSnippet');
  assert.ok(saved.range instanceof monaco.Range);

  const initialize = requests.find((request) => request.method === 'initialize');
  assert.ok(initialize);
  assert.equal(requests[0].expectedProjectRoot, projectRoot);
  const opened = notifications[0].messages[0];
  assert.equal(opened.method, 'textDocument/didOpen');
  assert.equal(opened.params.textDocument.uri, 'blode://workspace/main.c');
  assert.equal(opened.params.textDocument.text, 'void draft_symbol(void) {}\n');
  assert.equal(opened.params.textDocument.version, 1);

  version = 2;
  text = 'void renamed_symbol(void) {}\n';
  await completionNames();
  const changed = notifications[1].messages[0];
  assert.equal(changed.method, 'textDocument/didChange');
  assert.equal(changed.params.textDocument.version, 2);
  assert.equal(changed.params.contentChanges[0].text, text);

  const hover = await [...hovers.get('cpp')!][0].provideHover(model, { lineNumber: 1, column: 6 });
  assert.match(hover.contents[0].value, /void draft_symbol\(void\)/);
});

test('completion falls back to the draft index when the language service is unavailable', async () => {
  installBridge(false);
  setCompletionProject([{ path: 'main.c', content: 'void saved(void) {}' }], { projectRoot });
  registerCompletions(monaco);
  const names = (await completionNames()).map((item) => item.label);
  assert.ok(names.includes('saved'));
  assert.ok(names.includes('draft_symbol') === false, 'the stale host draft must not leak through');
});
