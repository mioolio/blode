export type MenuTarget = 'file' | 'folder' | 'root';

export interface ContextMenuItem {
  id: string;
  /** Locale key, never a literal label. */
  labelKey: string;
  command: string;
  /** Targets that show this item; omitted means every target. */
  when?: MenuTarget[];
  shortcut?: string;
  separator?: false;
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;
