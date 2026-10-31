import test from 'node:test';
import assert from 'node:assert/strict';
import { ClangdClient } from '../src/renderer/editor/clangd/client';

const projectRoot = '/workspace';
const requests: any[] = [];
const notifications: any[] = [];
const state = {
  available: true,
  source: 'bundled',
  version: '23.1.0',
  expectedVersion: '23.1.0',
  installable: true,
  hostSupported: true,
};

let version = 1;
let text = 'void draft(void) {}\n';
const model = {
  uri: { path: `${projectRoot}/main.c` },
  getVersionId: () => version,
  getValue: () => text,
  getValueLength: () => text.length,
  getLanguageId: () => 'c',
  isDisposed: () => false,
  getWordUntilPosition: (position: any) => {
    const line = text.split('\n')[position.lineNumber - 1] ?? '';
    const before = line.slice(0, position.column - 1);
    const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? '';
    return { word, startColumn: position.column - word.length, endColumn: position.column };
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
  editor: { getModels: () => [model], setModelMarkers: () => {} },
  languages: {
    CompletionItemKind: {},
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
} as any;

function installBridge(available = true) {
  (globalThis as any).window = {
    blode: {
      languageClangdState: async () => ({ ...state, available }),
      languageClangdRequest: async (request: any) => {
        requests.push(request);
        if (request.method === 'textDocument/completion')
          return {
            isIncomplete: false,
            items: [
              {
                label: ' draft(void)',
                kind: 3,
                detail: 'void',
                filterText: 'draft',
                insertText: 'draft(${1:})',
                insertTextFormat: 2,
                textEdit: {
                  range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
                  newText: 'draft(${1:})',
                },
              },
            ],
          };
        if (request.method === 'textDocument/hover')
          return { contents: { kind: 'markdown', value: '### clangd hover' } };
        if (request.method === 'textDocument/definition')
          return [{ path: 'board.h', line: 3, column: 6, endLine: 3, endColumn: 16 }];
        if (request.method === 'textDocument/references')
          return [{ path: 'main.c', line: 1, column: 1, endLine: 1, endColumn: 5 }];
        if (request.method === 'textDocument/formatting')
          return [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: '  ',
            },
          ];
        if (request.method === 'textDocument/documentSymbol')
          return [
            {
              name: 'loop',
              kind: 12,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
              selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 9 } },
            },
          ];
        if (request.method === 'workspace/symbol')
          return [
            {
              name: 'loop',
              kind: 12,
              path: 'main.c',
              line: 1,
              column: 6,
              endLine: 1,
              endColumn: 10,
            },
          ];
        if (request.method === 'textDocument/codeAction')
          return [
            {
              title: 'Include <stdio.h>',
              kind: 'quickfix',
              isPreferred: true,
              edit: [
                {
                  path: 'main.c',
                  edits: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                      newText: '#include <stdio.h>\n',
                    },
                  ],
                },
              ],
            },
            {
              title: 'Extract function',
              kind: 'refactor.extract',
              command: { title: 'Extract function', command: 'clangd.applyTweak', arguments: [{ id: 'x' }] },
            },
          ];
        if (request.method === 'workspace/executeCommand')
          return [
            {
              path: 'main.c',
              edits: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                  newText: '#include <stdio.h>\n',
                },
              ],
            },
          ];
        return null;
      },
      languageClangdNotify: async (batch: any) => {
        notifications.push(batch);
      },
      languageClangdDiagnostics: async () => ({
        items: [
          {
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
            severity: 1,
            message: 'undeclared identifier',
            source: 'clang',
          },
        ],
      }),
    },
  };
}

test('clangd CompletionItem text edits map to Monaco snippets and ranges', async () => {
  installBridge();
  const client = new ClangdClient({ projectRoot: () => projectRoot, resolvePath: () => 'main.c' });
  const items = await client.completion(monaco, 'main.c', model as any, { lineNumber: 1, column: 1 });
  assert.equal(items?.length, 1);
  const item = items![0];
  assert.equal(item.label, 'draft(void)');
  assert.equal(item.insertText, 'draft(${1:})');
  assert.equal(item.insertTextRules, 4);
  assert.ok(item.range instanceof monaco.Range);
  assert.equal((item.range as any).startColumn, 6);
  assert.equal((item.range as any).endColumn, 11);

  const opened = notifications[0].messages[0];
  assert.equal(opened.method, 'textDocument/didOpen');
  assert.equal(opened.params.textDocument.uri, 'blode://workspace/main.c');
  assert.equal(opened.params.textDocument.text, text);

  version = 2;
  text = 'void renamed(void) {}\n';
  await client.completion(monaco, 'main.c', model as any, { lineNumber: 1, column: 1 });
  assert.equal(notifications[1].messages[0].method, 'textDocument/didChange');
  assert.equal(notifications[1].messages[0].params.textDocument.version, 2);
});

test('clangd hover, definition, references and diagnostics stay typed', async () => {
  installBridge();
  const client = new ClangdClient({ projectRoot: () => projectRoot, resolvePath: () => 'main.c' });
  const hover = await client.hover(monaco, 'main.c', model as any, { lineNumber: 1, column: 6 });
  assert.match(hover!.contents[0].value, /clangd hover/);
  const definition = await client.definition(monaco, 'main.c', model as any, { lineNumber: 1, column: 6 });
  assert.deepEqual(definition, [{ path: 'board.h', line: 3, column: 6, endLine: 3, endColumn: 16 }]);
  const references = await client.references(monaco, 'main.c', model as any, { lineNumber: 1, column: 6 });
  assert.deepEqual(references, [{ path: 'main.c', line: 1, column: 1, endLine: 1, endColumn: 5 }]);
  const diagnostics = await client.diagnostics(monaco, 'main.c', model as any);
  assert.equal(diagnostics?.[0].severity, 1);
  assert.equal(diagnostics?.[0].message, 'undeclared identifier');
});

test('formatting, code actions, symbols and command edits reach the client', async () => {
  installBridge();
  const client = new ClangdClient({ projectRoot: () => projectRoot, resolvePath: () => 'main.c' });
  const formatting = await client.formatting(monaco, 'main.c', model as any, {
    tabSize: 2,
    insertSpaces: true,
  });
  assert.equal(formatting?.[0].newText, '  ');

  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 12 } as any;
  const actions = await client.codeActions(monaco, 'main.c', model as any, range, []);
  assert.equal(actions?.length, 2);
  assert.equal(actions?.[0].edit?.[0].path, 'main.c');
  assert.equal(actions?.[1].command?.command, 'clangd.applyTweak');

  const workspace = await client.workspaceSymbols('loop');
  assert.equal(workspace?.[0].path, 'main.c');
  assert.equal(workspace?.[0].line, 1);

  const symbols = await client.documentSymbols(monaco, 'main.c', model as any);
  assert.equal(symbols?.[0].name, 'loop');

  const edits = await client.executeCommand({
    title: 'Include <stdio.h>',
    command: 'clangd.applyFix',
    arguments: [{ id: 'fix' }],
  });
  assert.equal(edits?.[0].path, 'main.c');
  assert.equal(edits?.[0].edits[0].newText, '#include <stdio.h>\n');
});

test('unavailable clangd yields no completion so the host index fallback can run', async () => {
  installBridge(false);
  const client = new ClangdClient({ projectRoot: () => projectRoot, resolvePath: () => 'main.c' });
  assert.equal(await client.available(), false);
  assert.equal(
    await client.completion(monaco, 'main.c', model as any, { lineNumber: 1, column: 1 }),
    undefined,
  );
});
