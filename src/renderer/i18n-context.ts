import { createContext } from 'react';
import type { Locale } from '../shared/locales';
export type { Locale } from '../shared/locales';
export interface I18nValue {
  locale: Locale;
  setLocale: (value: Locale) => void;
  t: (key: string) => string;
}
// Keep context identity outside the hot-reloaded provider module.
export const I18nContext = createContext<I18nValue | null>(null);
