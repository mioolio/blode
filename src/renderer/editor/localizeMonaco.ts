import labels from './menu-labels.json';
import { loadLocale, translate } from '../localization';
import { resolveLocale } from '../../shared/locales';
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
const originals = new WeakMap<object, Map<string, Title>>();
function localizeTitle(owner: object, key: string, value: Title, locale: string): Title {
  let saved = originals.get(owner);
  if (!saved) {
    saved = new Map();
    originals.set(owner, saved);
  }
  if (!saved.has(key)) saved.set(key, value);
  const original = saved.get(key)!;
  if ((resolveLocale(locale) ?? 'en') === 'en') return original;
  const english = typeof original === 'string' ? original : (original.original ?? original.value);
  const label = (labels as Record<string, string>)[
    english
      .replaceAll('&&', '')
      .replace(/\(&.\)/g, '')
      .trim()
  ];
  if (!label) return original;
  const translated = translate(locale, label);
  return typeof original === 'string'
    ? translated
    : { ...original, value: translated, mnemonicTitle: translated };
}
/** Uses the existing menu entries, preserving their command IDs, guards and keybindings. */
export function localizeEditorMenu(registry: EditorMenuRegistry, root: object, locale: string): void {
  const seen = new Set<object>();
  const visit = (id: object) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const item of registry.getMenuItems(id)) {
      for (const command of [item.command, item.alt])
        if (command && !command.id.startsWith('blode.')) {
          command.title = localizeTitle(command, 'title', command.title, locale);
          if (command.shortTitle)
            command.shortTitle = localizeTitle(command, 'shortTitle', command.shortTitle, locale);
        }
      if (item.submenu) {
        if (item.title) item.title = localizeTitle(item, 'title', item.title, locale);
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
  await loadLocale(resolveLocale(locale) ?? 'en');
  const { MenuRegistry, MenuId } = await import('monaco-editor/esm/vs/platform/actions/common/actions.js');
  if (generation !== current) return;
  localizeEditorMenu(MenuRegistry, MenuId.EditorContext, locale);
}
