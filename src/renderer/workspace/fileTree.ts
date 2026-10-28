/** Data-only input; inventory enumerates files independently of editor support. */
export interface FileTreeEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number;
  editable: boolean;
}

export interface FileTreeNode extends FileTreeEntry {
  name: string;
  children: FileTreeNode[];
}

const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Build a real hierarchy from complete relative paths. Exact paths, rather than
 * basenames or lowercase strings, preserve distinct modules and filename case.
 */
export function buildFileTree(entries: readonly FileTreeEntry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const directories = new Map<string, FileTreeNode>();
  const files = new Map<string, FileTreeNode>();

  const directory = (parts: string[]): FileTreeNode | undefined => {
    if (!parts.length) return undefined;
    const path = parts.join('/');
    const existing = directories.get(path);
    if (existing) return existing;
    const parent = directory(parts.slice(0, -1));
    const node: FileTreeNode = {
      name: parts.at(-1)!,
      path,
      kind: 'directory',
      size: 0,
      editable: false,
      children: [],
    };
    directories.set(path, node);
    (parent?.children ?? roots).push(node);
    return node;
  };

  for (const entry of entries) {
    const normalized = entry.path.replaceAll('\\', '/');
    const parts = normalized.split('/');
    // An invalid inventory row should not manufacture navigation outside the root.
    if (parts.some((part) => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(normalized))
      continue;
    if (entry.kind === 'directory') {
      directory(parts);
      continue;
    }
    const parent = directory(parts.slice(0, -1));
    const existing = files.get(normalized);
    if (existing) {
      existing.size = entry.size;
      existing.editable = entry.editable;
      continue;
    }
    const node: FileTreeNode = { ...entry, path: normalized, name: parts.at(-1)!, children: [] };
    files.set(normalized, node);
    (parent?.children ?? roots).push(node);
  }

  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      const comparison = names.compare(left.name, right.name);
      return comparison || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    });
    for (const node of nodes) if (node.kind === 'directory') sort(node.children);
  };
  sort(roots);
  return roots;
}
