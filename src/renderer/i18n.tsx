import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { I18nContext, type Locale } from './i18n-context';
import { isLocale, localeInfo, preferredLocale } from '../shared/locales';
import { isLocaleLoaded, loadLocale, translate } from './localization';
export { translate, loadLocale } from './localization';
export type { TextKey } from './localization';
export type { Locale } from './i18n-context';
function initialLocale() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('blode.locale');
  } catch {
    /* Storage may be disabled. */
  }
  return preferredLocale(saved, typeof navigator === 'undefined' ? [] : navigator.languages);
}
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, update] = useState<Locale>(() => {
    const preferred = initialLocale();
    return isLocaleLoaded(preferred) ? preferred : 'en';
  });
  const [, redraw] = useState(0);
  const revision = useRef(0);
  const alive = useRef(false);
  const setLocale = useCallback((value: Locale) => {
    if (!isLocale(value)) return;
    const request = ++revision.current;
    void loadLocale(value)
      .then(() => {
        if (!alive.current || request !== revision.current) return;
        update(value);
        redraw((current) => current + 1);
        try {
          localStorage.setItem('blode.locale', value);
        } catch {
          /* Keep the session preference. */
        }
      })
      .catch(() => {
        /* Retain the current locale when a chunk cannot be loaded. */
      });
  }, []);
  useEffect(() => {
    alive.current = true;
    setLocale(initialLocale());
    const changed = (event: StorageEvent) => {
      if (event.key === 'blode.locale') setLocale(preferredLocale(event.newValue, navigator.languages));
    };
    window.addEventListener('storage', changed);
    return () => {
      alive.current = false;
      revision.current++;
      window.removeEventListener('storage', changed);
    };
  }, [setLocale]);
  useEffect(() => {
    document.documentElement.lang = localeInfo[locale].tag;
    document.documentElement.dir = localeInfo[locale].direction;
  }, [locale]);
  return (
    <I18nContext.Provider value={{ locale, setLocale, t: (key) => translate(locale, key) }}>
      {children}
    </I18nContext.Provider>
  );
}
export const useI18n = () =>
  useContext(I18nContext) ?? {
    locale: 'zh-CN' as Locale,
    setLocale: (_: Locale) => {},
    t: (key: string) => translate('zh-CN', key),
  };
