/** Observe Monaco 0.55's discarded async work at its source when editors change or suggestions cancel. */
export function monacoHighlightCancellation() {
  return {
    name: 'blode-monaco-highlight-cancellation',
    transform(code: string, id: string) {
      const modulePath = id.replaceAll('\\', '/').split('?')[0];
      if (modulePath.endsWith('/monaco-editor/esm/vs/base/common/observableInternal/utils/runOnChange.js')) {
        let count = 0;
        const fixed = code.replace(/^(\s*)cb\(([^\n]+)\);/gm, (_, indent: string, args: string) => {
          count++;
          return `${indent}const blodeResult = cb(${args});\n${indent}if (blodeResult && typeof blodeResult.then === 'function') Promise.resolve(blodeResult).catch(onUnexpectedError);`;
        });
        if (count !== 3)
          throw new Error('Monaco observable callbacks changed; review their cancellation handling.');
        return { code: "import { onUnexpectedError } from '../../errors.js';\n" + fixed, map: null };
      }
      if (
        !modulePath.endsWith(
          '/monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js',
        )
      )
        return;
      let count = 0;
      const fixed = code.replace(/this\.runDelayer\.trigger\((\(\) => \{[^\n]*\})\);/g, (_, task: string) => {
        count++;
        return `this.runDelayer.trigger(${task}).catch(onUnexpectedError);`;
      });
      const triggers = code.match(/this\.runDelayer\.trigger\(/g)?.length ?? 0;
      if (count !== triggers)
        throw new Error('Monaco word-highlighter changed; review its cancellation handling.');
      return count ? { code: fixed, map: null } : undefined;
    },
  };
}
