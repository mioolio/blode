import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { ClangdService } from '../src/core/clangd/manager';
import { lspUriForWorkspacePath } from '../src/shared/lsp';

const root = '/workspace';

function service(toolchainRoot: string) {
  return new ClangdService({
    core: {
      currentProjectRoot: () => root,
      workspaceSnapshot: async () => ({ projectRoot: root, files: [] }),
      currentConfig: () => ({}) as any,
    },
    dataRoot: path.join(toolchainRoot, '..', 'data'),
    toolchainRoot,
    platform: 'win32',
    arch: 'x64',
    env: { PATH: '' },
  });
}

test('clangd state reports a missing managed installation without spawning a process', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-service-'));
  try {
    const value = service(directory);
    const state = await value.state();
    assert.equal(state.available, false);
    assert.equal(state.source, null);
    assert.equal(state.expectedVersion, '23.1.0');
    assert.equal(state.installable, true);
    assert.equal(state.hostSupported, true);
    await assert.rejects(
      value.request({
        expectedProjectRoot: root,
        method: 'textDocument/completion',
        params: {
          textDocument: { uri: lspUriForWorkspacePath('main.c') },
          position: { line: 0, character: 0 },
        },
      }),
      /error\.clangdUnavailable/,
    );
    await value.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('clangd requests reject other workspace roots before starting a session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blode-clangd-service-'));
  try {
    const value = service(directory);
    await assert.rejects(
      value.request({
        expectedProjectRoot: '/elsewhere',
        method: 'textDocument/hover',
        params: {
          textDocument: { uri: lspUriForWorkspacePath('main.c') },
          position: { line: 0, character: 0 },
        },
      }),
      /error\.collaborationProjectChanged/,
    );
    await value.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
