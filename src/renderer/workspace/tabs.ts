export interface FileTabState {
  files: string[];
  preview: string;
}

export type ToolTab = 'layout' | 'ai';
export interface StoredSession {
  openFiles: string[];
  openTools: ToolTab[];
  activePath: string;
}
export const sessionKey = (root: string) => `blode.session:${root}`;

/** Per-project tab state survives reloads; missing or corrupt data means a fresh start. */
export function readSession(root: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(root));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    return {
      openFiles:
        parsed.version === 2 && Array.isArray(parsed.openFiles)
          ? parsed.openFiles.filter((value): value is string => typeof value === 'string')
          : [],
      openTools: Array.isArray(parsed.openTools)
        ? parsed.openTools.filter((value): value is ToolTab => value === 'layout' || value === 'ai')
        : [],
      activePath: parsed.version === 2 && typeof parsed.activePath === 'string' ? parsed.activePath : '',
    };
  } catch {
    return null;
  }
}

/** Browsing replaces only the previous preview; pinned files stay in their order. */
export function previewFile(state: FileTabState, path: string): FileTabState {
  if (state.files.includes(path)) return state;
  return { files: [...state.files.filter((file) => file !== state.preview), path], preview: path };
}

/** Save or a real edit promotes a preview to a persistent tab. */
export function pinFileTab(state: FileTabState, path: string): FileTabState {
  return {
    files: state.files.includes(path) ? state.files : [...state.files, path],
    preview: state.preview === path ? '' : state.preview,
  };
}

export function persistentFiles(state: FileTabState): string[] {
  return state.files.filter((file) => file !== state.preview);
}
