type Title = string | { value: string; original?: string; mnemonicTitle?: string };
interface Command {
  id: string;
  title: Title;
  shortTitle?: Title;
}
interface MenuItem {
  command?: Command;
  alt?: Command;
  submenu?: object;
  title?: Title;
}
export interface EditorMenuRegistry {
  getMenuItems(id: object): readonly MenuItem[];
  appendMenuItem(id: object, item: MenuItem): { dispose(): void };
}
const translations: Record<string, string> = {
  'Go to Definition': '转到定义',
  'Go to Declaration': '转到声明',
  'Go to Type Definition': '转到类型定义',
  'Go to Implementations': '转到实现',
  'Go to References': '转到引用',
  'Go to Symbol...': '转到编辑器符号…',
  'Go to Symbol in Editor...': '转到编辑器符号…',
  Peek: '速览',
  'Peek Definition': '速览定义',
  'Peek Declaration': '速览声明',
  'Peek Type Definition': '速览类型定义',
  'Peek Implementations': '速览实现',
  'Peek References': '速览引用',
  'Find All References': '查找所有引用',
  'Rename Symbol': '重命名符号',
  'Change All Occurrences': '更改所有匹配项',
  'Format Document': '格式化文档',
  'Format Selection': '格式化选区',
  'Format Document With...': '使用指定格式化程序…',
  'Format Selection With...': '使用指定格式化程序格式化选区…',
  'Refactor...': '重构…',
  'Source Action...': '源代码操作…',
  'Quick Fix...': '快速修复…',
  Cut: '剪切',
  Copy: '复制',
  Paste: '粘贴',
  'Copy As': '复制为',
  'Copy With Syntax Highlighting': '复制并保留语法高亮',
  Undo: '撤销',
  Redo: '重做',
  'Select All': '全选',
  'Command Palette': '命令面板',
  'Command Palette...': '命令面板…',
  'Toggle Line Comment': '切换行注释',
  'Toggle Block Comment': '切换块注释',
  Fold: '折叠',
  Unfold: '展开',
  'Fold All': '全部折叠',
  'Unfold All': '全部展开',
  'Show Hover': '显示悬停提示',
  'Show Definition Preview Hover': '显示定义预览',
  'Open Link': '打开链接',
  'Add Cursor Above': '在上方添加光标',
  'Add Cursor Below': '在下方添加光标',
  Find: '查找',
  Replace: '替换',
  'Find in Selection': '在选区中查找',
};
const originals = new WeakMap<object, Map<string, Title>>();
function localizeTitle(owner: object, key: string, value: Title, chinese: boolean): Title {
  let saved = originals.get(owner);
  if (!saved) {
    saved = new Map();
    originals.set(owner, saved);
  }
  if (!saved.has(key)) saved.set(key, value);
  const original = saved.get(key)!;
  if (!chinese) return original;
  const english = typeof original === 'string' ? original : (original.original ?? original.value);
  const translated =
    translations[
      english
        .replaceAll('&&', '')
        .replace(/\(&.\)/g, '')
        .trim()
    ];
  if (!translated) return original;
  return typeof original === 'string'
    ? translated
    : { ...original, value: translated, mnemonicTitle: translated };
}
/** Uses the existing menu entries, preserving their command IDs, guards and keybindings. */
export function localizeEditorMenu(registry: EditorMenuRegistry, root: object, locale: string): void {
  const seen = new Set<object>(),
    chinese = /^zh(?:-|$)/i.test(locale);
  const visit = (id: object) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const item of registry.getMenuItems(id)) {
      for (const command of [item.command, item.alt])
        if (command && !command.id.startsWith('blode.')) {
          command.title = localizeTitle(command, 'title', command.title, chinese);
          if (command.shortTitle)
            command.shortTitle = localizeTitle(command, 'shortTitle', command.shortTitle, chinese);
        }
      if (item.submenu) {
        if (item.title) item.title = localizeTitle(item, 'title', item.title, chinese);
        visit(item.submenu);
      }
    }
    // Monaco caches resolved menu groups; one immediately removed item invalidates that cache.
    registry.appendMenuItem(id, { command: { id: 'blode.nls.refresh', title: '' } }).dispose();
  };
  visit(root);
}
let generation = 0;
export async function localizeMonacoContextMenu(locale: string): Promise<void> {
  const current = ++generation;
  const { MenuRegistry, MenuId } = await import('monaco-editor/esm/vs/platform/actions/common/actions.js');
  if (generation !== current) return;
  localizeEditorMenu(MenuRegistry, MenuId.EditorContext, locale);
}
