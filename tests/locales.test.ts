import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zh from '../src/renderer/locales/zh-CN.json';
import en from '../src/renderer/locales/en.json';
import automationZh from '../src/automation/locales/zh-CN.json';
import automationEn from '../src/automation/locales/en-US.json';
import { translate } from '../src/renderer/i18n';

const root = fileURLToPath(new URL('..', import.meta.url));
const chinese: Record<string, string> = { ...automationZh, ...zh };
const english: Record<string, string> = { ...automationEn, ...en };

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? files(fullPath) : Promise.resolve([fullPath]);
    }),
  );
  return nested.flat();
}

function assertTranslated(key: string, source: string): void {
  assert.ok(chinese[key]?.trim(), `${source}: missing Chinese key ${key}`);
  assert.ok(english[key]?.trim(), `${source}: missing English key ${key}`);
}

test('Chinese and English dictionaries have identical, non-empty keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(automationZh).sort(), Object.keys(automationEn).sort());
  for (const key of Object.keys(chinese)) assertTranslated(key, 'locale');
});

test('all direct t calls, board descriptions and backend error/status keys are translated', async () => {
  const referenced = new Set<string>();
  const directories = ['src/renderer', 'src/core', 'src/automation', 'extensions', 'scripts'];
  for (const directory of directories) {
    for (const file of await files(path.join(root, directory))) {
      // General extensions own their locale catalogs; validate them separately below.
      if (file.startsWith(path.join(root, 'extensions', 'plugins') + path.sep)) continue;
      if (/\.(ts|tsx|mjs)$/.test(file)) {
        const content = await readFile(file, 'utf8');
        for (const match of content.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) referenced.add(match[2]);
        for (const match of content.matchAll(/\b(?:label|shortcut):\s*(['"])([^'"]+)\1/g))
          referenced.add(match[2]);
        for (const match of content.matchAll(/['"`]((?:error|errors|status|rpc)\.[A-Za-z0-9]+)/g))
          referenced.add(match[1]);
      }
      if (path.basename(file) === 'manifest.json') {
        const manifest = JSON.parse(await readFile(file, 'utf8')) as { descriptionKey?: string };
        if (manifest.descriptionKey) referenced.add(manifest.descriptionKey);
      }
    }
  }
  assert.deepEqual(
    [...referenced].filter((key) => !chinese[key]?.trim() || !english[key]?.trim()),
    [],
    'All referenced keys need both translations',
  );
  // Dynamic maps are deliberately explicit: adding a new branch needs a translation.
  for (const key of [
    'workspace.code',
    'workspace.layout',
    'workspace.ai',
    'console.output',
    'console.serial',
    'console.problems',
    'layout.app',
    'layout.data',
    'layout.system',
    'memory.flash',
    'memory.ram',
  ])
    assertTranslated(key, 'dynamic UI map');
});

test('general extension examples keep independent complete locale catalogs', async () => {
  const directory = path.join(root, 'extensions/plugins/Personalization');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const localZh = JSON.parse(await readFile(path.join(directory, manifest.locales['zh-CN']), 'utf8'));
  const localEn = JSON.parse(await readFile(path.join(directory, manifest.locales.en), 'utf8'));
  assert.deepEqual(Object.keys(localZh).sort(), Object.keys(localEn).sort());
  for (const key of Object.keys(localZh)) {
    assert.ok(localZh[key]?.trim(), key);
    assert.ok(localEn[key]?.trim(), key);
  }
  const referenced = new Set<string>();
  for (const file of await files(directory))
    if (/\.(?:mjs|js)$/.test(file))
      for (const match of (await readFile(file, 'utf8')).matchAll(/\bt\(\s*(['"])([^'"]+)\1/g))
        referenced.add(match[2]);
  for (const menu of manifest.ui.menus) if (menu.labelKey) referenced.add(menu.labelKey);
  for (const field of manifest.settings.fields) {
    referenced.add(field.label);
    for (const option of field.options ?? []) referenced.add(option.label);
  }
  for (const key of referenced) {
    assert.ok(localZh[key]?.trim(), key);
    assert.ok(localEn[key]?.trim(), key);
  }
});

test('protocol-key translation preserves filename suffixes and raw tool output', () => {
  assert.equal(translate('zh-CN', 'status.downloading arduino-cli.zip'), '正在下载 arduino-cli.zip');
  assert.equal(translate('en', 'status.downloading arduino-cli.zip'), 'Downloading arduino-cli.zip');
  assert.equal(translate('zh-CN', 'rpc.serverError: EADDRINUSE'), '系统管道服务错误: EADDRINUSE');
  assert.equal(
    translate('zh-CN', "Error invoking remote method 'blode:request': Error: error.busy"),
    zh['error.busy'],
  );
  assert.equal(translate('en', 'Error: errors.boardMismatch'), en['errors.boardMismatch']);
  assert.equal(
    translate('zh-CN', 'Sketch uses 3456 bytes (1%) of program storage space.'),
    'Sketch uses 3456 bytes (1%) of program storage space.',
  );
  assert.equal(
    translate('zh-CN', 'Error: custom compiler diagnostic\n  at line 3'),
    'Error: custom compiler diagnostic\n  at line 3',
  );
  assert.equal(translate('zh-CN', 'unknown.extension.key'), 'unknown.extension.key');
  assert.equal(translate('en', 'state.get'), automationEn['state.get']);
});
