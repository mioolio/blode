export interface FileTabState {
  files: string[];
  preview: string;
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
