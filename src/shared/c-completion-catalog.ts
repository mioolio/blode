import type { CompletionEntry, LanguageCompletions } from '../../extensions/completions/types';
import type { AiCompletionEntry } from './ai';
import { resolveCompletionCatalog } from './completion-catalog';

/** C uses its selected standard, plus compatibility overrides from cpp then c. */
export function resolveCCompletionCatalog(
  selectedPack: LanguageCompletions,
  projectSymbols: readonly CompletionEntry[],
  overrides: readonly AiCompletionEntry[],
): LanguageCompletions {
  const entries = [
    ...overrides.filter((entry) => entry.language === 'cpp'),
    ...overrides.filter((entry) => entry.language === 'c'),
  ].map((entry) => ({ ...entry, language: 'c' }));
  return (
    resolveCompletionCatalog(
      [{ ...selectedPack, language: 'c', symbols: [...(selectedPack.symbols ?? []), ...projectSymbols] }],
      entries,
      true,
    )[0] ?? { language: 'c', symbols: [], snippets: [], members: [] }
  );
}
