import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeEditorMenu, type EditorMenuRegistry } from '../src/renderer/editor/localizeMonaco';

test('Monaco context menus localize built-ins recursively and restore their original titles', () => {
  const root = {},
    peek = {};
  const command = {
    id: 'editor.action.revealDefinition',
    title: { value: 'Go to Definition', original: 'Go to Definition', mnemonicTitle: 'Go to &&Definition' },
    precondition: 'hasDefinitionProvider',
  };
  const custom = { id: 'blode.askAI', title: 'Ask AI' };
  const cut = { id: 'editor.action.clipboardCutAction', title: 'Cut' };
  const symbols = { id: 'editor.action.quickOutline', title: 'Go to Symbol...' };
  const peekItem = { submenu: peek, title: 'Peek' };
  const items = new Map<object, any[]>([
    [root, [{ command }, peekItem, { command: custom }]],
    [peek, [{ command: cut }, { command: symbols }]],
  ]);
  let invalidations = 0;
  const registry: EditorMenuRegistry = {
    getMenuItems: (id) => items.get(id) ?? [],
    appendMenuItem: () => {
      invalidations++;
      return { dispose() {} };
    },
  };
  const original = command.title;
  localizeEditorMenu(registry, root, 'zh-CN');
  assert.equal(command.title.value, '转到定义');
  assert.equal(command.precondition, 'hasDefinitionProvider');
  assert.equal(cut.title, '剪切');
  assert.equal(symbols.title, '转到编辑器符号…');
  assert.equal(peekItem.title, '速览');
  assert.equal(custom.title, 'Ask AI', 'application actions keep their own i18n');
  assert.equal(invalidations, 2);
  localizeEditorMenu(registry, root, 'en');
  assert.equal(command.title, original);
  assert.equal(cut.title, 'Cut');
  assert.equal(peekItem.title, 'Peek');
  localizeEditorMenu(registry, root, 'zh-CN');
  assert.equal(cut.title, '剪切', 'repeated locale switches do not lose English originals');
});
