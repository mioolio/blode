import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { supportedLocales, localeInfo, preferredLocale, resolveLocale } from '../src/shared/locales';
import { isLocaleLoaded, loadLocale, translate } from '../src/renderer/localization';
import { I18nContext } from '../src/renderer/i18n-context';
import { Settings } from '../src/renderer/components/Settings';
import { getBoardAdapter } from '../extensions/registry';
import { uiCommandSchema } from '../src/core/ui-commands';
import { localizeEditorMenu } from '../src/renderer/editor/localizeMonaco';
import english from '../src/renderer/locales/en.json';

test('language registry covers mainstream locales and normalizes browser and stored language variants', () => {
  assert.equal(new Set(supportedLocales).size, 13);
  for (const locale of supportedLocales) {
    assert.ok(localeInfo[locale].name);
    assert.ok(localeInfo[locale].show);
    assert.ok(localeInfo[locale].quit);
    assert.doesNotThrow(() => new Intl.DateTimeFormat(localeInfo[locale].tag).format(0));
    assert.equal(uiCommandSchema.parse({ action: 'language', language: locale }).language, locale);
  }
  assert.equal(resolveLocale('en_GB'), 'en');
  assert.equal(resolveLocale('zh-Hant-HK'), 'zh-TW');
  assert.equal(resolveLocale('pt-PT'), 'pt-BR');
  assert.equal(preferredLocale('de', ['ja']), 'de');
  assert.equal(preferredLocale('invalid', ['xx', 'ja-JP']), 'ja');
  assert.equal(preferredLocale(null, ['xx']), 'en');
  assert.equal(uiCommandSchema.safeParse({ action: 'language', language: 'xx' }).success, false);
});

test('language catalogs load once for concurrent requests and become available before switching UI', async () => {
  assert.equal(isLocaleLoaded('ja'), false);
  const first = loadLocale('ja'),
    second = loadLocale('ja');
  assert.equal(first, second);
  await first;
  assert.equal(isLocaleLoaded('ja'), true);
  assert.notEqual(translate('ja', 'menu.file'), english['menu.file']);
});

test('all catalogs contain every UI key and preserve placeholders and technical file references', async () => {
  const keys = Object.keys(english).sort();
  for (const locale of supportedLocales) {
    const file = path.resolve(`src/renderer/locales/${locale}.json`);
    const dictionary = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>;
    assert.deepEqual(Object.keys(dictionary).sort(), keys, locale);
    for (const [key, text] of Object.entries(english)) {
      const translated = dictionary[key];
      assert.ok(typeof translated === 'string' && translated.trim(), `${locale}/${key}`);
      assert.doesNotMatch(translated, /__KEEP_|__BLODE_|ZXQKEEP/);
      // Chinese base catalogs predate the new translation pass and may paraphrase filenames.
      if (locale === 'zh-CN') continue;
      for (const [token] of text.matchAll(
        /\{[A-Za-z_][A-Za-z0-9_.]*\}|%(?:\d+\$)?[sdif]|\b[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+\b|--[a-z][a-z0-9-]*/g,
      ))
        assert.ok(translated.includes(token), `${locale}/${key}: missing ${token}`);
    }
    await loadLocale(locale);
    assert.notEqual(translate(locale, 'menu.file'), 'menu.file');
    assert.equal(translate(locale, 'unknown.plugin.key'), 'unknown.plugin.key');
    assert.equal(
      translate(locale, 'status.downloading firmware.bin'),
      dictionary['status.downloading'] + ' firmware.bin',
    );
    assert.equal(
      translate(locale, 'compiler: undefined reference to main'),
      'compiler: undefined reference to main',
    );
  }
  assert.equal(translate('unsupported', 'menu.file'), english['menu.file']);
});

test('preferences render native language names for every supported language', async () => {
  for (const locale of supportedLocales) {
    await loadLocale(locale);
    const html = renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        {
          value: { locale, setLocale() {}, t: (key) => translate(locale, key) },
        },
        createElement(Settings, {
          config: getBoardAdapter('auto').createConfig(),
          status: {} as never,
          drivers: [],
          workspaceOpen: false,
          onChange() {},
          onSave() {},
          onInstallDriver() {},
          onRefreshDrivers() {},
          busy: false,
          isWeb: true,
        }),
      ),
    );
    for (const language of supportedLocales) assert.ok(html.includes(localeInfo[language].name), language);
    const label = renderToStaticMarkup(
      createElement('span', null, translate(locale, 'settings.language')),
    ).replace(/^<span>|<\/span>$/g, '');
    assert.ok(html.includes(label), locale);
  }
});

test('editor menus switch across all languages without losing native command bindings or English originals', async () => {
  const command = {
    id: 'editor.action.revealDefinition',
    title: 'Go to Definition',
    precondition: 'hasProvider',
  };
  const root = {};
  const registry = { getMenuItems: () => [{ command }], appendMenuItem: () => ({ dispose() {} }) };
  for (const locale of supportedLocales) {
    await loadLocale(locale);
    localizeEditorMenu(registry, root, locale);
    assert.equal(command.title, translate(locale, 'editor.menu.Go to Definition'));
    assert.equal(command.id, 'editor.action.revealDefinition');
    assert.equal(command.precondition, 'hasProvider');
  }
  localizeEditorMenu(registry, root, 'en');
  assert.equal(command.title, 'Go to Definition');
});

test('the official extension owns complete language catalogs independently of the host', async () => {
  const directory = path.resolve('extensions/plugins/Personalization');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const base = JSON.parse(await fs.readFile(path.join(directory, manifest.locales.en), 'utf8'));
  for (const locale of supportedLocales) {
    const catalog = JSON.parse(await fs.readFile(path.join(directory, manifest.locales[locale]), 'utf8'));
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(base).sort(), locale);
    assert.ok(Object.values(catalog).every((value) => typeof value === 'string' && value.trim()));
  }
});
