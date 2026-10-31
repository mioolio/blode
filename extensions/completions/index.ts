import type { LanguageCompletions } from './types.js';

/**
 * Built-in C/Arduino JSON completion packs were removed. C/C++ completion is
 * answered by clangd, or by the host workspace index when clangd is not
 * installed. Project JSON, AI entries and module user contributions still flow
 * through their own resolvers.
 */
export function listLanguageCompletions(): readonly LanguageCompletions[] {
  return [];
}
