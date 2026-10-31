import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWorkspaceSymbols } from '../src/renderer/workspace/symbolSearch';

const root = '/workspace';

test('workspace symbol search uses clangd when available', async () => {
  const original = globalThis.window;
  let requested: any;
  (globalThis as any).window = {
    blode: {
      languageClangdState: async () => ({
        available: true,
        source: 'bundled',
        expectedVersion: '23.1.0',
        installable: true,
        hostSupported: true,
      }),
      languageClangdRequest: async (request: any) => {
        requested = request;
        return [
          {
            name: 'board_init',
            kind: 12,
            path: 'src/main.c',
            line: 12,
            column: 6,
            endLine: 12,
            endColumn: 16,
          },
        ];
      },
      languageIndex: async () => ({ symbols: [] }),
    },
  };
  try {
    const result = await searchWorkspaceSymbols(root, 'board');
    assert.equal(result[0].name, 'board_init');
    assert.deepEqual(requested, {
      expectedProjectRoot: root,
      method: 'workspace/symbol',
      params: { query: 'board' },
    });
  } finally {
    (globalThis as any).window = original;
  }
});

test('workspace symbol search falls back to the host index', async () => {
  const original = globalThis.window;
  (globalThis as any).window = {
    blode: {
      languageClangdState: async () => ({
        available: false,
        source: null,
        expectedVersion: '23.1.0',
        installable: true,
        hostSupported: true,
      }),
      languageClangdRequest: async () => {
        throw new Error('should not run');
      },
      languageIndex: async () => ({
        symbols: [
          {
            name: 'loop',
            kind: 'function',
            signature: 'void loop(void)',
            definition: true,
            path: 'main.c',
            line: 3,
            column: 6,
            endLine: 3,
            endColumn: 10,
          },
          {
            name: 'LED_PIN',
            kind: 'constant',
            signature: '#define LED_PIN 13',
            definition: true,
            path: 'pins.h',
            line: 1,
            column: 9,
            endLine: 1,
            endColumn: 16,
          },
        ],
      }),
    },
  };
  try {
    const result = await searchWorkspaceSymbols(root, 'loop');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'loop');
    assert.equal(result[0].path, 'main.c');
    assert.equal(result[0].line, 3);
    assert.equal(result[0].kind, 12);
  } finally {
    (globalThis as any).window = original;
  }
});
