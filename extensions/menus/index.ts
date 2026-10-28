import { explorerContextMenu } from './explorer.js';
import type { ContextMenuEntry } from './types.js';

/** Explicit registration; add a pack here and the explorer renders it automatically. */
const menus: Record<'explorer', ContextMenuEntry[]> = {
  explorer: explorerContextMenu,
};

export function getContextMenu(id: keyof typeof menus): ContextMenuEntry[] {
  return menus[id];
}
