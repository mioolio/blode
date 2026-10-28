import type * as Monaco from 'monaco-editor';
import { listLanguageCompletions } from '../../../extensions/completions';
import type {
  CompletionEntry,
  CompletionKind,
  LanguageCompletions,
} from '../../../extensions/completions/types';

type MonacoApi = typeof import('monaco-editor');

const sortOrder: Record<CompletionKind, string> = {
  snippet: '0',
  function: '1',
  method: '1',
  type: '2',
  variable: '3',
  constant: '4',
  property: '5',
  keyword: '6',
};

const hasSnippetSyntax = (value: string) => /\$\{\d+[:}]/.test(value);

function completionKind(monaco: MonacoApi, kind: CompletionKind): Monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'function':
      return kinds.Function;
    case 'method':
      return kinds.Method;
    case 'variable':
      return kinds.Variable;
    case 'constant':
      return kinds.Constant;
    case 'type':
      return kinds.Class;
    case 'keyword':
      return kinds.Keyword;
    case 'snippet':
      return kinds.Snippet;
    case 'property':
      return kinds.Property;
  }
}

function toSuggestion(
  monaco: MonacoApi,
  entry: CompletionEntry,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const insertText = entry.insertText ?? entry.name;
  return {
    label: entry.name,
    kind: completionKind(monaco, entry.kind),
    detail: entry.detail,
    documentation: entry.documentation ? { value: entry.documentation } : undefined,
    insertText,
    insertTextRules: hasSnippetSyntax(insertText)
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    sortText: entry.sortText ?? `${sortOrder[entry.kind]}-${entry.name}`,
    range,
  };
}

function createProvider(
  monaco: MonacoApi,
  contribution: LanguageCompletions,
): Monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: contribution.triggerCharacters,
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // Only the owner's members belong after a dot; global symbols would otherwise
      // flood every member access with unrelated Arduino functions.
      const access = /([A-Za-z_]\w*)\s*\.\s*\w*$/.exec(linePrefix);
      if (access) {
        const group = contribution.members?.find((candidate) => candidate.owner === access[1]);
        return {
          suggestions: group ? group.members.map((entry) => toSuggestion(monaco, entry, range)) : [],
        };
      }
      const entries = [...(contribution.snippets ?? []), ...(contribution.symbols ?? [])];
      return { suggestions: entries.map((entry) => toSuggestion(monaco, entry, range)) };
    },
  };
}

function createHoverProvider(
  monaco: MonacoApi,
  contribution: LanguageCompletions,
): Monaco.languages.HoverProvider {
  const entries = [
    ...(contribution.symbols ?? []),
    ...(contribution.snippets ?? []),
    ...(contribution.members ?? []).flatMap((group) => group.members),
  ];
  return {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const entry = entries.find((candidate) => candidate.name === word.word);
      if (!entry) return null;
      const contents: Monaco.IMarkdownString[] = [{ value: `\`\`\`cpp\n${entry.detail}\n\`\`\`` }];
      if (entry.documentation) contents.push({ value: entry.documentation });
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents,
      };
    },
  };
}

interface CompletionScope {
  __blodeCompletionDisposables?: Monaco.IDisposable[];
}

/**
 * Converts every registered language pack into Monaco providers. Called once from
 * the editor module; a global disposal slot keeps Vite hot reload from stacking
 * duplicate providers.
 */
export function registerCompletions(monaco: MonacoApi): void {
  const scope = globalThis as typeof globalThis & CompletionScope;
  scope.__blodeCompletionDisposables?.forEach((disposable) => disposable.dispose());
  const disposables: Monaco.IDisposable[] = [];
  for (const contribution of listLanguageCompletions()) {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(
        contribution.language,
        createProvider(monaco, contribution),
      ),
    );
    disposables.push(
      monaco.languages.registerHoverProvider(
        contribution.language,
        createHoverProvider(monaco, contribution),
      ),
    );
  }
  scope.__blodeCompletionDisposables = disposables;
}
