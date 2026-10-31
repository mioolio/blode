import test from 'node:test';
import assert from 'node:assert/strict';
import { registerClangdDiagnostics } from '../src/renderer/editor/clangd/diagnostics';

test('clangd diagnostics stay on translation units instead of guessing header/sketch context', async () => {
  const markers: { owner: string; items: unknown[] }[] = [];
  const model = {
    uri: { path: '/workspace/SerialCamera.ino' },
    getLanguageId: () => 'cpp',
    isDisposed: () => false,
    onDidChangeContent: () => ({ dispose() {} }),
    onWillDispose: () => ({ dispose() {} }),
  };
  const monaco = {
    editor: {
      getModels: () => [model],
      onDidCreateModel: () => ({ dispose() {} }),
      setModelMarkers: (_model: unknown, owner: string, items: unknown[]) => markers.push({ owner, items }),
    },
  } as any;
  const calls: string[] = [];
  const client = {
    diagnostics: async (path: string) => {
      calls.push(path);
      return [];
    },
    available: async () => true,
  } as any;
  const disposables: { dispose(): void }[] = [];
  registerClangdDiagnostics(
    monaco,
    client,
    (uriPath) => (uriPath.endsWith('SerialCamera.ino') ? 'SerialCamera.ino' : ''),
    disposables,
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(calls, []);
  const last = markers.at(-1);
  assert.equal(last?.owner, 'clangd');
  assert.deepEqual(last?.items, []);
  for (const disposable of disposables) disposable.dispose();
});
