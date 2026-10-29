import type { ContextMenuEntry } from './types.js';

/**
 * Reference explorer menu. Entries are declarative; the renderer owns command
 * handlers, so another extension can add an item without touching ProjectExplorer.
 */
export const explorerContextMenu: ContextMenuEntry[] = [
  { id: 'new-file', labelKey: 'action.new', command: 'explorer.newFile' },
  {
    id: 'new-folder',
    labelKey: 'action.newFolder',
    command: 'explorer.newFolder',
    when: ['folder', 'root'],
  },
  { separator: true },
  {
    id: 'project-settings',
    labelKey: 'project.settings',
    command: 'explorer.projectSettings',
    when: ['file'],
    whenPath: 'be',
  },
  {
    id: 'set-build-entry',
    labelKey: 'action.setBuildEntry',
    command: 'explorer.setBuildEntry',
    when: ['file', 'folder', 'root'],
  },
  { separator: true },
  {
    id: 'reveal',
    labelKey: 'action.reveal',
    command: 'explorer.reveal',
    when: ['file', 'folder'],
  },
  {
    id: 'copy-path',
    labelKey: 'action.copyPath',
    command: 'explorer.copyPath',
    when: ['file', 'folder'],
  },
  {
    id: 'copy-relative-path',
    labelKey: 'action.copyRelativePath',
    command: 'explorer.copyRelativePath',
    when: ['file', 'folder'],
  },
  { separator: true },
  {
    id: 'rename',
    labelKey: 'action.rename',
    command: 'explorer.rename',
    when: ['file', 'folder'],
  },
  {
    id: 'delete',
    labelKey: 'action.deleteEntry',
    command: 'explorer.delete',
    when: ['file', 'folder'],
  },
  { separator: true },
  { id: 'refresh', labelKey: 'action.refresh', command: 'explorer.refresh' },
];
