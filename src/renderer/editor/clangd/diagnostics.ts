import type * as Monaco from 'monaco-editor';
import { toMonacoMarker } from '../lspConvert';
import type { ClangdClient } from './client';

type MonacoApi = typeof import('monaco-editor/esm/vs/editor/editor.api.js');

const sourceFile = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ino)$/i;
/** Headers and Arduino sketches depend on build preprocessing; clangd parses them without that context. */
const diagnosticUnit = /\.(?:c|cc|cpp|cxx)$/i;
const DIAGNOSTIC_OWNER = 'clangd';

/**
 * clangd publishes diagnostics asynchronously. Requests are debounced and
 * repeated once so a slow first parse still replaces the markers.
 */
export function registerClangdDiagnostics(
  monaco: MonacoApi,
  client: ClangdClient,
  resolvePath: (uriPath: string) => string,
  disposables: Monaco.IDisposable[],
): void {
  const timers = new Map<Monaco.editor.ITextModel, ReturnType<typeof setTimeout>[]>();

  const clear = (model: Monaco.editor.ITextModel) => {
    for (const timer of timers.get(model) ?? []) clearTimeout(timer);
    timers.delete(model);
  };

  const apply = async (model: Monaco.editor.ITextModel, path: string) => {
    if (model.isDisposed?.()) return;
    const items = await client.diagnostics(monaco, path, model);
    if (model.isDisposed?.()) return;
    if (items === undefined) {
      if (!(await client.available())) monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, []);
      return;
    }
    monaco.editor.setModelMarkers(
      model,
      DIAGNOSTIC_OWNER,
      items.map((item) => toMonacoMarker(monaco, item)),
    );
  };

  const schedule = (model: Monaco.editor.ITextModel) => {
    const path = resolvePath(model.uri.path);
    if (!path || !sourceFile.test(path)) return;
    clear(model);
    if (!diagnosticUnit.test(path)) {
      monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, []);
      return;
    }
    timers.set(model, [
      setTimeout(() => void apply(model, path), 450),
      setTimeout(() => void apply(model, path), 1_800),
      setTimeout(() => void apply(model, path), 5_000),
    ]);
  };

  const seen = new WeakSet<Monaco.editor.ITextModel>();
  const attach = (model: Monaco.editor.ITextModel) => {
    if (seen.has(model)) return;
    seen.add(model);
    disposables.push(model.onDidChangeContent?.(() => schedule(model)) ?? { dispose() {} });
    disposables.push(
      model.onWillDispose?.(() => {
        clear(model);
        monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, []);
      }) ?? { dispose() {} },
    );
    schedule(model);
  };
  for (const model of monaco.editor.getModels?.() ?? []) attach(model);
  disposables.push(monaco.editor.onDidCreateModel(attach));
}
