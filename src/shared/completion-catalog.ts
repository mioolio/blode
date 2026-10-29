import type { LanguageCompletions, CompletionEntry } from '../../extensions/completions/types';
import type { AiCompletionEntry } from './ai';

/** Flat user entries override a builtin by language, owner and label. */
export function resolveCompletionCatalog(
  builtins: readonly LanguageCompletions[],
  entries: readonly AiCompletionEntry[],
  useBuiltins: boolean,
): LanguageCompletions[] {
  const values = new Map<string, { language: string; owner?: string; entry: CompletionEntry }>();
  const triggers = new Map<string, Set<string>>();
  const key = (language: string, owner: string | undefined, name: string) =>
    `${language}\0${owner ?? ''}\0${name}`;
  for (const pack of useBuiltins ? builtins : []) {
    triggers.set(
      pack.language,
      new Set([...(triggers.get(pack.language) ?? []), ...(pack.triggerCharacters ?? [])]),
    );
    for (const entry of [...(pack.symbols ?? []), ...(pack.snippets ?? [])])
      values.set(key(pack.language, undefined, entry.name), { language: pack.language, entry });
    for (const group of pack.members ?? [])
      for (const entry of group.members)
        values.set(key(pack.language, group.owner, entry.name), {
          language: pack.language,
          owner: group.owner,
          entry,
        });
  }
  for (const { language, owner, disabled, ...entry } of entries) {
    const id = key(language, owner, entry.name);
    if (disabled) values.delete(id);
    else values.set(id, { language, owner, entry });
  }
  const result = new Map<string, LanguageCompletions>();
  for (const { language, owner, entry } of values.values()) {
    const pack = result.get(language) ?? {
      language,
      triggerCharacters: [...(triggers.get(language) ?? ['.', '#'])],
      symbols: [],
      snippets: [],
      members: [],
    };
    result.set(language, pack);
    if (owner) {
      let group = pack.members!.find((candidate) => candidate.owner === owner);
      if (!group) {
        group = { owner, members: [] };
        pack.members!.push(group);
      }
      group.members.push(entry);
    } else if (entry.kind === 'snippet') pack.snippets!.push(entry);
    else pack.symbols!.push(entry);
  }
  return [...result.values()];
}
