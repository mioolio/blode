import { arduinoCompletions } from './arduino.js';
import type { LanguageCompletions } from './types.js';

/**
 * Explicit registration keeps completion packs declarative and inspectable.
 * Several packs may target the same language; the renderer merges their results.
 */
const contributions: readonly LanguageCompletions[] = [arduinoCompletions];

export function listLanguageCompletions(): readonly LanguageCompletions[] {
  return contributions;
}
