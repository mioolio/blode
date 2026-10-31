import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCompletions,
  setCompletionCatalog,
  setCompletionProject,
} from '../src/renderer/editor/completionProvider';

const root = '/workspace';
const providers = new Map<string, Set<any>>();
const notifications: any[] = [];
const requests: any[] = [];
const disposable = () => ({ dispose() {} });

let available = true;
let text = 'void local(void) {}\n';
const model = {
  uri: { path: `${root}/main.c` },
  getVersionId: () => 1,
  getValue: () => text,
  getValueLength: () => text.length,
  getLanguageId: () => 'c',
  isDisposed: () => false,
  onDidChangeContent: () => ({ dispose() {} }),
  onWillDispose: () => ({ dispose() {} }),
  getWordUntilPosition: (position: any) => {
    const line = text.split('\n')[position.lineNumber - 1] ?? '';
    const before = line.slice(0, position.column - 1);
    const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? '';
    return { word, startColumn: position.column - word.length, endColumn: position.column };
  },
  getValueInRange: (range: any) => {
    const line = text.split('\n')[range.startLineNumber - 1] ?? '';
    return line.slice(range.startColumn - 1, range.endColumn - 1);
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
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
  Uri: { file: (value: string) => ({ path: value, toString: () => 'file://' + value }) },
  editor: {
    getModels: () => [model],
    getModel: () => undefined,
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
    registerHoverProvider: () => disposable(),
    registerDefinitionProvider: () => disposable(),
    registerDeclarationProvider: () => disposable(),
    registerReferenceProvider: () => disposable(),
    registerLinkProvider: () => disposable(),
  },
} as any;

function installBridge(withClangd: boolean) {
  (globalThis as any).window = {
    blode: {
      languageLspRequest: async () => ({ items: [] }),
      languageLspNotify: async () => {},
      languageClangdState: async () => ({
        available: withClangd,
        source: withClangd ? 'bundled' : null,
        expectedVersion: '23.1.0',
        installable: true,
        hostSupported: true,
      }),
      languageClangdRequest: async (request: any) => {
        requests.push(request);
        if (request.method === 'textDocument/completion')
          return {
            isIncomplete: false,
            items: [
              {
                label: ' clangd_symbol(int value)',
                filterText: 'clangd_symbol',
                kind: 3,
                detail: 'void',
                insertText: 'clangd_symbol(${1:int value})',
                insertTextFormat: 2,
                textEdit: {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: 'clangd_symbol(${1:int value})',
                },
              },
            ],
          };
        return null;
      },
      languageClangdNotify: async (batch: any) => {
        notifications.push(batch);
      },
      languageClangdDiagnostics: async () => ({ items: [] }),
    },
  };
}

async function completionLabels() {
  const responses = await Promise.all(
    [...providers.get('cpp')!].map((provider) =>
      Promise.resolve(provider.provideCompletionItems(model, { lineNumber: 1, column: 1 })),
    ),
  );
  return responses.flatMap((response: any) =>
    response.suggestions.map((item: any) => (typeof item.label === 'string' ? item.label : item.label.label)),
  );
}

test('C/C++ completion prefers clangd results and keeps the draft index fallback', async () => {
  available = true;
  installBridge(true);
  setCompletionCatalog({ useBuiltins: false, entries: [] });
  setCompletionProject(
    [
      { path: 'main.c', content: 'void local(void) {}' },
      { path: 'board.h', content: 'void board_init(int mode);' },
    ],
    { projectRoot: root },
  );
  registerCompletions(monaco);
  const labels = await completionLabels();
  assert.ok(labels.includes('clangd_symbol(int value)'), labels.join(','));
  assert.ok(labels.includes('local'), labels.join(','));
  assert.ok(labels.includes('board_init'), labels.join(','));
  assert.equal(notifications[0].messages[0].params.textDocument.uri, 'blode://workspace/main.c');
  assert.ok(requests.some((request) => request.method === 'textDocument/completion'));
});

test('without clangd the host index keeps completion working', async () => {
  available = false;
  installBridge(false);
  requests.length = 0;
  notifications.length = 0;
  // Reset the singleton clients so the new availability is observed.
  setCompletionProject([], { projectRoot: `${root}-reset` });
  setCompletionProject([{ path: 'main.c', content: 'void local(void) {}' }], { projectRoot: root });
  registerCompletions(monaco);
  const labels = await completionLabels();
  assert.ok(labels.includes('local'), labels.join(','));
  assert.ok(!requests.some((request) => request.method === 'textDocument/completion'));
});
