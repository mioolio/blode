import { createContext } from 'react';
export type Locale = 'zh-CN' | 'en';
export interface I18nValue {
  locale: Locale;
  setLocale: (value: Locale) => void;
  t: (key: string) => string;
}
// Keep context identity outside the hot-reloaded provider module.
export const I18nContext = createContext<I18nValue | null>(null);
