import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiCompletionSettings } from '../src/renderer/components/AiCompletionSettings';
import { I18nContext } from '../src/renderer/i18n-context';
import { translate } from '../src/renderer/i18n';

test('AI completion preferences expose automatic opt-in, timing bounds and the manual shortcut', () => {
  const html = renderToStaticMarkup(createElement(AiCompletionSettings));
  assert.match(html, /自动 AI 补全/);
  assert.match(html, /type="checkbox" disabled=""/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /type="number"[^>]*min="100"[^>]*max="10000"[^>]*value="750"/);
  assert.match(html, /手动补全/);
  assert.match(html, /<kbd>Ctrl\+Alt\+Space<\/kbd>/);
});

test('manual completion feedback and timing validation are available in both interface languages', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const html = renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { locale, setLocale() {}, t: (key) => translate(locale, key) } },
        createElement(AiCompletionSettings),
      ),
    );
    assert.match(html, locale === 'en' ? /Automatic AI completion/ : /自动 AI 补全/);
    for (const key of [
      'ai.completions.complete',
      'ai.completions.requesting',
      'ai.completions.ready',
      'ai.completions.empty',
      'error.aiPredictionTimeout',
      'error.aiPredictionUnavailable',
      'error.aiPredictionDelay',
    ])
      assert.notEqual(translate(locale, key), key);
  }
});
