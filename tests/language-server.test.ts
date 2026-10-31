import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLanguageServer } from '../src/core/language-server';
import {
  lspUriForWorkspacePath,
  workspacePathFromLspUri,
  type LspCompletionList,
  type LspHover,
  type LspInitializeResult,
} from '../src/shared/lsp';
import type {
  LanguageExternalSource,
  LanguageNavigationRequest,
  SourceLocation,
} from '../src/shared/language';

const root = '/workspace';
const files = [
  { path: 'main.c', language: 'c', content: '#include "board.h"\nvoid loop(void) {}\n' },
  {
    path: 'board.h',
    language: 'c',
    content: '#define BOARD_LED 13\nvoid board_init(int mode);\n',
  },
];
const externalId = 'b'.repeat(32);
const external: LanguageExternalSource = {
  id: externalId,
  path: `@external/${externalId}/Arduino.h`,
  name: 'Arduino.h',
  displayPath: 'C:/arduino/cores/arduino/Arduino.h',
  content:
    '#define digitalWrite(pin, value) digitalWriteImpl(pin, value)\nvoid pinMode(int pin, int mode);\n',
  language: 'cpp',
  readonly: true,
};

function createServer() {
  let navigationCalls = 0;
  const navigation = {
    async navigate(request: LanguageNavigationRequest): Promise<SourceLocation[]> {
      if (request.kind !== 'include' || request.specifier !== 'Arduino.h') return [];
      navigationCalls++;
      return [{ path: external.path, externalId, line: 1, column: 1, endLine: 1, endColumn: 1 }];
    },
    async openExternal(): Promise<LanguageExternalSource> {
      return external;
    },
  };
  const core = {
    async workspaceSnapshot() {
      return { projectRoot: root, files };
    },
    currentProjectRoot: () => root,
  };
  const server = new WorkspaceLanguageServer({ core, navigation });
  return { server, navigationCalls: () => navigationCalls };
}

const draft = [
  '#include <Arduino.h>',
  'void draft_symbol(void) {}',
  'void loop(void) {',
  '  board_init(1);',
  '  board.',
  '  digitalWrite(1, 1);',
  '}',
].join('\n');

async function openDraft(server: WorkspaceLanguageServer) {
  await server.notify({
    expectedProjectRoot: root,
    messages: [
      {
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: lspUriForWorkspacePath('main.c'),
            languageId: 'c',
            version: 1,
            text: draft,
          },
        },
      },
    ],
  });
}

test('language server advertises a full-sync completion and hover subset', async () => {
  const { server } = createServer();
  const result = (await server.request({
    expectedProjectRoot: root,
    method: 'initialize',
    params: { processId: null, rootUri: null, capabilities: {} },
  })) as LspInitializeResult;
  assert.equal(result.serverInfo.name, 'blode-workspace-language-server');
  assert.deepEqual(result.capabilities.textDocumentSync, { openClose: true, change: 1 });
  assert.ok(result.capabilities.completionProvider?.triggerCharacters?.includes('.'));
  assert.equal(result.capabilities.hoverProvider, true);
});

test('completion filters draft symbols by prefix and inserts function snippets', async () => {
  const { server } = createServer();
  await openDraft(server);
  const list = (await server.request({
    expectedProjectRoot: root,
    method: 'textDocument/completion',
    params: {
      textDocument: { uri: lspUriForWorkspacePath('main.c') },
      position: { line: 3, character: 8 },
    },
  })) as LspCompletionList;
  const names = list.items.map((item) => item.label);
  assert.deepEqual(names, ['board_init']);
  const init = list.items[0];
  assert.equal(init.insertTextFormat, 2);
  assert.equal(init.insertText, 'board_init(${1:})');
  assert.equal(init.kind, 3);
  assert.match(init.detail ?? '', /board_init/);
});

test('completion merges include-resolved header symbols and caches header scans', async () => {
  const { server, navigationCalls } = createServer();
  await openDraft(server);
  const request = {
    expectedProjectRoot: root,
    method: 'textDocument/completion' as const,
    params: {
      textDocument: { uri: lspUriForWorkspacePath('main.c') },
      position: { line: 2, character: 0 },
    },
  };
  const first = (await server.request(request)) as LspCompletionList;
  const names = first.items.map((item) => item.label);
  for (const name of ['draft_symbol', 'BOARD_LED', 'board_init', 'digitalWrite', 'pinMode'])
    assert.ok(names.includes(name), name);
  assert.equal(navigationCalls(), 1);
  const second = (await server.request(request)) as LspCompletionList;
  assert.ok(second.items.some((item) => item.label === 'digitalWrite'));
  assert.equal(navigationCalls(), 1, 'resolved headers are cached between requests');
});

test('member access is left to the declarative catalog', async () => {
  const { server } = createServer();
  await openDraft(server);
  const list = (await server.request({
    expectedProjectRoot: root,
    method: 'textDocument/completion',
    params: {
      textDocument: { uri: lspUriForWorkspacePath('main.c') },
      position: { line: 4, character: 8 },
    },
  })) as LspCompletionList;
  assert.deepEqual(list.items, []);
});

test('hover reports project and included header symbols', async () => {
  const { server } = createServer();
  await openDraft(server);
  const project = (await server.request({
    expectedProjectRoot: root,
    method: 'textDocument/hover',
    params: {
      textDocument: { uri: lspUriForWorkspacePath('main.c') },
      position: { line: 2, character: 7 },
    },
  })) as LspHover;
  assert.match(project.contents.value, /void loop\(void\)/);
  assert.match(project.contents.value, /main\.c:3/);

  const header = (await server.request({
    expectedProjectRoot: root,
    method: 'textDocument/hover',
    params: {
      textDocument: { uri: lspUriForWorkspacePath('main.c') },
      position: { line: 5, character: 4 },
    },
  })) as LspHover;
  assert.match(header.contents.value, /digitalWrite/);
  assert.match(header.contents.value, /Arduino\.h/);

  const missing = (await server.request({
    expectedProjectRoot: root,
    method: 'textDocument/hover',
    params: {
      textDocument: { uri: lspUriForWorkspacePath('main.c') },
      position: { line: 0, character: 2 },
    },
  })) as LspHover | null;
  assert.equal(missing, null);
});

test('workspace URIs reject foreign schemes and traversal', () => {
  assert.equal(workspacePathFromLspUri('file:///etc/passwd'), undefined);
  assert.equal(workspacePathFromLspUri('blode://workspace/'), undefined);
  assert.equal(workspacePathFromLspUri('blode://workspace/..%2Fsecret.c'), undefined);
  assert.equal(workspacePathFromLspUri(lspUriForWorkspacePath('src/main.c')), 'src/main.c');
  assert.throws(() => lspUriForWorkspacePath('../secret.c'), /error.invalidPath/);
  assert.throws(() => lspUriForWorkspacePath(''), /error.invalidPath/);
});

test('completion resolves saved workspace files without an explicit didOpen', async () => {
  const { server } = createServer();
  const list = (await server.request({
    expectedProjectRoot: root,
    method: 'textDocument/completion',
    params: {
      textDocument: { uri: lspUriForWorkspacePath('board.h') },
      position: { line: 0, character: 0 },
    },
  })) as LspCompletionList;
  const names = list.items.map((item) => item.label);
  assert.ok(names.includes('BOARD_LED'));
  assert.ok(names.includes('board_init'));
});

test('foreign roots, unsafe URIs and malformed positions are rejected', async () => {
  const { server } = createServer();
  await assert.rejects(
    server.request({ expectedProjectRoot: '/elsewhere', method: 'initialize' }),
    /error\.collaborationProjectChanged/,
  );
  await assert.rejects(
    server.notify({
      expectedProjectRoot: root,
      messages: [
        {
          method: 'textDocument/didOpen',
          params: {
            textDocument: { uri: 'file:///etc/passwd', languageId: 'c', version: 1, text: '' },
          },
        },
      ],
    }),
    /rpc\.invalidParams/,
  );
  await openDraft(server);
  await assert.rejects(
    server.request({
      expectedProjectRoot: root,
      method: 'textDocument/completion',
      params: {
        textDocument: { uri: lspUriForWorkspacePath('main.c') },
        position: { line: 999, character: 0 },
      },
    }),
    /rpc\.invalidParams/,
  );
  await assert.rejects(
    server.request({
      expectedProjectRoot: root,
      method: 'textDocument/completion',
      params: { textDocument: { uri: lspUriForWorkspacePath('main.c') } },
    }),
    /rpc\.invalidParams/,
  );
  await assert.rejects(
    server.notify({
      expectedProjectRoot: root,
      messages: [{ method: 'textDocument/didChange', params: { textDocument: {} } }],
    }),
    /rpc\.invalidParams/,
  );
});

test('didChange replaces the document text used by the next completion', async () => {
  const { server } = createServer();
  await openDraft(server);
  await server.notify({
    expectedProjectRoot: root,
    messages: [
      {
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri: lspUriForWorkspacePath('main.c'), version: 2 },
          contentChanges: [{ text: 'void fresh_symbol(void) {}\n' }],
        },
      },
    ],
  });
  const list = (await server.request({
    expectedProjectRoot: root,
    method: 'textDocument/completion',
    params: {
      textDocument: { uri: lspUriForWorkspacePath('main.c') },
      position: { line: 1, character: 0 },
    },
  })) as LspCompletionList;
  const names = list.items.map((item) => item.label);
  assert.ok(names.includes('fresh_symbol'));
  assert.ok(!names.includes('draft_symbol'));
});
