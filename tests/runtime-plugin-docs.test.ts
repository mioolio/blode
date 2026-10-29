import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRuntimePluginManifest } from '../src/core/runtime-plugin-schema';
import { moduleLanguageCatalogSchema, moduleLanguagesSchema } from '../src/shared/module-languages';

test('the runtime plugin guide examples match the actual host schema', async () => {
  const guide = await readFile(new URL('../docs/RUNTIME-PLUGINS.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```json\s*([\s\S]+?)```/g)].map((match) => JSON.parse(match[1]));
  assert.equal(examples.length, 3);
  const manifest = parseRuntimePluginManifest(examples[0]);
  assert.equal(manifest.id, 'Acme_F103_USB');
  assert.equal(manifest.defaultConfig.runtime?.values?.interface, 'usb0');
  const ownCompiler = parseRuntimePluginManifest({ ...manifest, compiler: examples[1] });
  assert.equal(ownCompiler.compiler.mode, 'plugin');
  assert.equal(ownCompiler.compiler.defaultTool?.runner, 'node');
  const withViews = parseRuntimePluginManifest({ ...manifest, ...examples[2] });
  assert.deepEqual(
    withViews.ui.views?.map((view) => [view.id, view.location]),
    [
      ['logic', 'window'],
      ['trace', 'panel'],
    ],
  );
});

test('module language guide examples match the declaration and catalog schemas', async () => {
  const guide = await readFile(new URL('../docs/MODULE-LANGUAGES.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```json\s*([\s\S]+?)```/g)].map((match) => JSON.parse(match[1]));
  assert.equal(examples.length, 3);
  assert.equal(moduleLanguagesSchema.parse(examples[0]).mode, 'declared');
  assert.equal(moduleLanguagesSchema.parse(examples[1]).mode, 'fixed');
  assert.equal(moduleLanguageCatalogSchema.parse(examples[2]).rules?.[0].id, 'legacy-camera-init');
});
