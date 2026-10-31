import type { LspWorkspaceSymbol } from '../../shared/lsp';

const kindFor = (kind: string): number => {
  switch (kind) {
    case 'function':
      return 12;
    case 'type':
      return 23;
    case 'variable':
      return 13;
    case 'macro':
    case 'constant':
      return 14;
    default:
      return 13;
  }
};

/**
 * clangd workspace symbols when available; otherwise filter the host language
 * index so symbol search still works offline.
 */
export async function searchWorkspaceSymbols(root: string, query: string): Promise<LspWorkspaceSymbol[]> {
  if (typeof window === 'undefined' || !root) return [];
  const bridge = window.blode;
  if (!bridge) return [];
  try {
    if (typeof bridge.languageClangdState === 'function') {
      const state = await bridge.languageClangdState();
      if (state.available) {
        const result = await bridge.languageClangdRequest({
          expectedProjectRoot: root,
          method: 'workspace/symbol',
          params: { query },
        });
        if (Array.isArray(result) && result.length) return result as LspWorkspaceSymbol[];
      }
    }
  } catch {
    /* Fall back to the workspace index. */
  }
  try {
    const index = await bridge.languageIndex();
    const needle = query.toLowerCase();
    return index.symbols
      .filter((symbol) => !needle || symbol.name.toLowerCase().includes(needle))
      .slice(0, 200)
      .map((symbol) => ({
        name: symbol.name,
        kind: kindFor(symbol.kind),
        path: symbol.path,
        line: symbol.line,
        column: symbol.column,
        endLine: symbol.endLine,
        endColumn: symbol.endColumn,
      }));
  } catch {
    return [];
  }
}
