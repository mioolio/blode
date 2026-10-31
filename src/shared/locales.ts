/** UI locales are shared by renderer, desktop lifecycle and automation schemas. */
export const supportedLocales = [
  'zh-CN',
  'zh-TW',
  'en',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'pt-BR',
  'it',
  'ru',
  'ar',
  'hi',
] as const;
export type Locale = (typeof supportedLocales)[number];
export const localeInfo: Record<
  Locale,
  { name: string; tag: string; direction: 'ltr' | 'rtl'; show: string; quit: string }
> = {
  'zh-CN': { name: '简体中文', tag: 'zh-CN', direction: 'ltr', show: '显示 Blode Studio', quit: '退出' },
  'zh-TW': { name: '繁體中文', tag: 'zh-TW', direction: 'ltr', show: '顯示 Blode Studio', quit: '結束' },
  en: { name: 'English', tag: 'en', direction: 'ltr', show: 'Show Blode Studio', quit: 'Quit' },
  ja: { name: '日本語', tag: 'ja', direction: 'ltr', show: 'Blode Studio を表示', quit: '終了' },
  ko: { name: '한국어', tag: 'ko', direction: 'ltr', show: 'Blode Studio 표시', quit: '종료' },
  de: { name: 'Deutsch', tag: 'de', direction: 'ltr', show: 'Blode Studio anzeigen', quit: 'Beenden' },
  fr: { name: 'Français', tag: 'fr', direction: 'ltr', show: 'Afficher Blode Studio', quit: 'Quitter' },
  es: { name: 'Español', tag: 'es', direction: 'ltr', show: 'Mostrar Blode Studio', quit: 'Salir' },
  'pt-BR': {
    name: 'Português (Brasil)',
    tag: 'pt-BR',
    direction: 'ltr',
    show: 'Mostrar Blode Studio',
    quit: 'Sair',
  },
  it: { name: 'Italiano', tag: 'it', direction: 'ltr', show: 'Mostra Blode Studio', quit: 'Esci' },
  ru: { name: 'Русский', tag: 'ru', direction: 'ltr', show: 'Показать Blode Studio', quit: 'Выход' },
  ar: { name: 'العربية', tag: 'ar', direction: 'rtl', show: 'إظهار Blode Studio', quit: 'خروج' },
  hi: { name: 'हिन्दी', tag: 'hi', direction: 'ltr', show: 'Blode Studio दिखाएँ', quit: 'बाहर निकलें' },
};
export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && supportedLocales.includes(value as Locale);
export function resolveLocale(value: string | undefined | null): Locale | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll('_', '-').toLowerCase();
  if (/^zh(?:-|$)/.test(normalized)) return /(?:tw|hk|mo|hant)/.test(normalized) ? 'zh-TW' : 'zh-CN';
  const language = normalized.split('-')[0];
  if (language === 'pt') return 'pt-BR';
  return supportedLocales.find((locale) => locale.toLowerCase() === normalized || locale === language);
}
export function preferredLocale(saved: string | null | undefined, languages: readonly string[] = []): Locale {
  return resolveLocale(saved) ?? languages.map(resolveLocale).find((locale) => locale !== undefined) ?? 'en';
}
