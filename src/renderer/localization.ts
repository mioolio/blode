import zh from './locales/zh-CN.json';
import en from './locales/en.json';
import automationZh from '../automation/locales/zh-CN.json';
import automationEn from '../automation/locales/en-US.json';
import { resolveLocale, type Locale } from '../shared/locales';

export type TextKey = keyof typeof zh | keyof typeof automationZh;
const dictionaries: Partial<Record<Locale, Record<string, string>>> = {
  'zh-CN': { ...automationZh, ...zh },
  en: { ...automationEn, ...en },
};
const loaders = {
  'zh-TW': () => import('./locales/zh-TW.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  de: () => import('./locales/de.json'),
  fr: () => import('./locales/fr.json'),
  es: () => import('./locales/es.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  it: () => import('./locales/it.json'),
  ru: () => import('./locales/ru.json'),
  ar: () => import('./locales/ar.json'),
  hi: () => import('./locales/hi.json'),
};
const pending = new Map<Locale, Promise<void>>();
export const isLocaleLoaded = (locale: Locale): boolean => !!dictionaries[locale];
export function loadLocale(locale: Locale): Promise<void> {
  if (dictionaries[locale]) return Promise.resolve();
  if (pending.has(locale)) return pending.get(locale)!;
  const task = loaders[locale as keyof typeof loaders]()
    .then((module) => {
      dictionaries[locale] = module.default;
    })
    .finally(() => pending.delete(locale));
  pending.set(locale, task);
  return task;
}

/** Protocol suffixes and compiler diagnostics are preserved verbatim. */
export function translate(locale: Locale | string, key: string): string {
  const dictionary = dictionaries[resolveLocale(locale) ?? 'en'];
  const lookup = (value: string) => dictionary?.[value] ?? dictionaries.en![value];
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
