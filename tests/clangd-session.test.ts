import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClangdSession } from '../src/core/clangd/session';
import type { ClangdTransport } from '../src/core/clangd/transport';
import type { LspPublishDiagnosticsParams } from '../src/shared/lsp';

const root = path.resolve('/workspace');
const file = (name: string) => pathToFileURL(path.join(root, name)).href;

class FakeTransport {
  requests: { method: string; params: any }[] = [];
  notifications: { method: string; params: any }[] = [];
  applied?: unknown;
  private handlers = new Set<(method: string, params: unknown) => void>();
  private serverHandler?: (method: string, params: unknown) => unknown;
  setServerRequestHandler(handler: (method: string, params: unknown) => unknown) {
    this.serverHandler = handler;
  }
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === 'initialize') return { capabilities: {} };
    if (method === 'textDocument/formatting')
      return [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: '  ',
        },
      ];
    if (method === 'textDocument/documentSymbol')
      return [
        {
          name: 'loop',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
          selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 9 } },
        },
      ];
    if (method === 'workspace/symbol')
      return [
        {
          name: 'loop',
          kind: 12,
          location: {
            uri: file('main.c'),
            range: { start: { line: 0, character: 5 }, end: { line: 0, character: 9 } },
          },
        },
      ];
    if (method === 'workspace/executeCommand') {
      this.applied = await this.serverHandler?.('workspace/applyEdit', {
        edit: {
          changes: {
            [file('main.c')]: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: '#include <stdio.h>\n',
              },
            ],
          },
        },
      });
      return null;
    }
    if (method === 'textDocument/definition')
      return [
        {
          uri: file('board.h'),
          range: {
            start: { line: 2, character: 5 },
            end: { line: 2, character: 15 },
          },
        },
        {
          uri: 'file:///outside/sdk.h',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ];
    if (method === 'textDocument/references')
      return [
        {
          uri: file('main.c'),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        },
      ];
    if (method === 'textDocument/completion') return { isIncomplete: false, items: [{ label: ' loop' }] };
    if (method === 'textDocument/hover') return { contents: { kind: 'markdown', value: 'hover' } };
    return null;
  }
  notify(method: string, params: any) {
    this.notifications.push({ method, params });
  }
  onNotification(handler: (method: string, params: unknown) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(method: string, params: unknown) {
    for (const handler of this.handlers) handler(method, params);
  }
  lastError() {
    return '';
  }
  dispose() {}
}

function session() {
  const transport = new FakeTransport();
  const value = new ClangdSession({
    transport: transport as unknown as ClangdTransport,
    root,
    fallbackFlags: ['-std=c17', '-I', root],
  });
  return { transport, session: value };
}

test('clangd session initializes with project fallback flags and full document sync', async () => {
  const { transport, session: value } = session();
  await value.initialize();
  const initialize = transport.requests.find((request) => request.method === 'initialize')!;
  assert.deepEqual(initialize.params.initializationOptions.fallbackFlags, ['-std=c17', '-I', root]);
  assert.equal(initialize.params.rootUri, pathToFileURL(root).href);
  assert.ok(transport.notifications.some((item) => item.method === 'initialized'));

  value.didOpen('main.c', 'int main(void) {}', 1);
  const open = transport.notifications.find((item) => item.method === 'textDocument/didOpen')!;
  assert.equal(open.params.textDocument.uri, file('main.c'));
  assert.equal(open.params.textDocument.languageId, 'c');
  assert.equal(open.params.textDocument.version, 1);

  value.didChange('main.c', 'int main(void) { return 0; }', 2);
  const change = transport.notifications.find((item) => item.method === 'textDocument/didChange')!;
  assert.equal(change.params.textDocument.version, 2);
  assert.equal(change.params.contentChanges[0].text, 'int main(void) { return 0; }');

  value.didClose('main.c');
  assert.ok(transport.notifications.some((item) => item.method === 'textDocument/didClose'));
});

test('definition and reference results become project-relative source locations', async () => {
  const { session: value } = session();
  await value.initialize();
  const definition = await value.definition('main.c', { line: 0, character: 4 });
  assert.deepEqual(definition, [{ path: 'board.h', line: 3, column: 6, endLine: 3, endColumn: 16 }]);
  const references = await value.references('main.c', { line: 0, character: 4 });
  assert.deepEqual(references, [{ path: 'main.c', line: 1, column: 1, endLine: 1, endColumn: 5 }]);
  const completion = (await value.completion('main.c', { line: 0, character: 0 })) as any;
  assert.equal(completion.items[0].label, ' loop');
  assert.equal(((await value.hover('main.c', { line: 0, character: 0 })) as any).contents.value, 'hover');
});

test('formatting, document symbols, workspace symbols and commands pass through the session', async () => {
  const { transport, session: value } = session();
  await value.initialize();
  const formatting = (await value.formatting('main.c', { tabSize: 2, insertSpaces: true })) as any[];
  assert.equal(formatting[0].newText, '  ');
  const symbols = (await value.documentSymbols('main.c')) as any[];
  assert.equal(symbols[0].name, 'loop');
  assert.equal(symbols[0].selectionRange.start.character, 5);
  const workspace = (await value.workspaceSymbols('loop')) as any[];
  assert.equal(workspace[0].location.uri, file('main.c'));

  const edits = (await value.executeCommand('clangd.applyFix', [{ key: 'value' }])) as any[];
  assert.deepEqual(transport.applied, { applied: true });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].changes[file('main.c')][0].newText, '#include <stdio.h>\n');
  assert.deepEqual(
    transport.requests.find((request) => request.method === 'workspace/executeCommand')?.params,
    {
      command: 'clangd.applyFix',
      arguments: [{ key: 'value' }],
    },
  );
});

test('publishDiagnostics is cached per project file and dropped on close', async () => {
  const { transport, session: value } = session();
  await value.initialize();
  value.didOpen('main.c', 'int main(void) { missing; }', 1);
  const params: LspPublishDiagnosticsParams = {
    uri: file('main.c'),
    version: 1,
    diagnostics: [
      {
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 23 } },
        severity: 1,
        message: 'use of undeclared identifier',
        source: 'clang',
      },
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 2,
        code: 'unused-includes',
        message: 'Included header is not used directly',
      },
    ],
  };
  transport.emit('textDocument/publishDiagnostics', params);
  assert.equal(value.diagnosticsFor('main.c').items.length, 1);
  assert.equal(value.diagnosticsFor('main.c').version, 1);
  transport.emit('textDocument/publishDiagnostics', { ...params, uri: 'file:///outside/x.c' });
  assert.equal(value.diagnosticsFor('main.c').items.length, 1);
  value.didClose('main.c');
  assert.deepEqual(value.diagnosticsFor('main.c').items, []);
});
