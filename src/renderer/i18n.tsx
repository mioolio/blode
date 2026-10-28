import { useContext, useEffect, useState, type ReactNode } from 'react';
import { I18nContext, type Locale } from './i18n-context';
import zh from './locales/zh-CN.json';
import en from './locales/en.json';
import automationZh from '../automation/locales/zh-CN.json';
import automationEn from '../automation/locales/en-US.json';
export type { Locale } from './i18n-context';
export type TextKey = keyof typeof zh | keyof typeof automationZh;
const dictionaries: Record<Locale, Record<string, string>> = {
  'zh-CN': { ...automationZh, ...zh },
  en: { ...automationEn, ...en },
};

/** Translate protocol keys and their diagnostic suffixes; preserve raw compiler output. */
export function translate(locale: Locale, key: string): string {
  const lookup = (value: string) => dictionaries[locale][value] ?? dictionaries.en[value];
  const exact = lookup(key);
  if (exact !== undefined) return exact;
  const wrapped = key
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    .replace(/^Error: (?=(?:error|errors|status|rpc)\.)/, '');
  const prefix = wrapped.match(/^((?:error|errors|status|rpc)\.[A-Za-z0-9]+)((?::\s*|\s+)[\s\S]*)?$/);
  if (prefix) {
    const label = lookup(prefix[1]);
    if (label !== undefined) return label + (prefix[2] ?? '');
  }
  return key;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, update] = useState<Locale>(() => {
    try {
      return localStorage.getItem('blode.locale') === 'en' ? 'en' : 'zh-CN';
    } catch {
      return 'zh-CN';
    }
  });
  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en-US' : locale;
  }, [locale]);
  const setLocale = (value: Locale) => {
    update(value);
    try {
      localStorage.setItem('blode.locale', value);
    } catch {
      /* A disabled storage backend must not block language switching. */
    }
  };
  return (
    <I18nContext.Provider value={{ locale, setLocale, t: (key) => translate(locale, key) }}>
      {children}
    </I18nContext.Provider>
  );
}
export const useI18n = () => useContext(I18nContext) ?? { locale: 'zh-CN' as Locale, setLocale: (_:Locale) => {}, t: (key:string) => translate('zh-CN',key) };
