import { promises as fs } from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import type { ProjectFile, ProjectConfig, ProjectInventory } from '../shared/contracts';
import { parseConfig, parseProjectDescriptor, type ProjectBuild } from './config';

const ignored = new Set(['.git', 'node_modules', '.blode', 'build', 'dist', '.cache']);
/** Known binary formats stay out of the text editor; everything else opens as plain text. */
const binaryExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tif',
  '.tiff',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.tar',
  '.bin',
  '.hex',
  '.elf',
  '.uf2',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.lib',
  '.o',
  '.obj',
  '.class',
  '.jar',
  '.pyc',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.webm',
  '.sqlite',
  '.db',
  '.dat',
  '.pak',
]);
const languageMap: Record<string, string> = {
  '.ino': 'cpp',
  '.h': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.hpp': 'cpp',
  '.c': 'cpp',
  '.cpp': 'cpp',
  '.tpp': 'cpp',
  '.ipp': 'cpp',
  '.json': 'json',
  '.md': 'markdown',
  '.ts': 'typescript',
  '.py': 'python',
};

/** Extensionless files and any non-binary format are editable as UTF-8 text. */
export function isEditableTextFile(filePath: string): boolean {
  return !binaryExtensions.has(path.extname(filePath).toLowerCase());
}

function languageFor(filePath: string): string {
  const extension = path.extname(filePath);
  return languageMap[extension] ?? languageMap[extension.toLowerCase()] ?? 'plaintext';
}

/** Resolve every path component, refusing junctions/symlinks as well as '..'. */
export async function safeWorkspacePath(
  root: string,
  relative: string,
  options: { internal?: boolean } = {},
): Promise<string> {
  if (!relative || relative.length > 1024 || path.isAbsolute(relative) || relative.includes('\0'))
    throw new Error('error.invalidPath');
  const parts = relative.replaceAll('\\', '/').split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        p.endsWith('.') ||
        p.endsWith(' ') ||
        p.includes(':') ||
        /[<>"|?*]/.test(p) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error('error.invalidPath');
  if (!options.internal && parts.some((p) => ignored.has(p.toLowerCase()) || p.startsWith('.')))
    throw new Error('error.protectedPath');
  const realRoot = await fs.realpath(root);
  let cursor = realRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('error.symlinkPath');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const relativeResult = path.relative(realRoot, cursor);
  if (relativeResult.startsWith('..') || path.isAbsolute(relativeResult))
    throw new Error('error.invalidPath');
  return cursor;
}

export async function readProjectFiles(root: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8 || files.length >= 150) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase()) || entry.name.startsWith('.'))
        continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, depth + 1);
      else if (isEditableTextFile(entry.name)) {
        const stat = await fs.stat(fullPath);
        if (stat.size > 1_000_000 || files.length >= 150) continue;
        files.push({
          path: path.relative(root, fullPath).replaceAll('\\', '/'),
          language: languageFor(entry.name),
          content: await fs.readFile(fullPath, 'utf8'),
        });
      }
    }
  }
  await walk(root, 0);
  return files;
}

export async function writeProjectFile(root: string, relative: string, content: string): Promise<void> {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000)
    throw new Error('error.fileTooLarge');
  if (!isEditableTextFile(relative)) throw new Error('error.fileType');
  const fullPath = await safeWorkspacePath(root, relative);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
}

/** Create without overwriting; the file name alone is enough, including no extension. */
export async function createProjectFile(root: string, relative: string): Promise<void> {
  const fullPath = await safeWorkspacePath(root, relative);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  try {
    await fs.writeFile(fullPath, '', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'EISDIR') throw new Error('toast.fileExists');
    throw error;
  }
}

export async function createProjectDirectory(root: string, relative: string): Promise<void> {
  const fullPath = await safeWorkspacePath(root, relative);
  await fs.mkdir(fullPath, { recursive: true });
}

export async function renameProjectEntry(root: string, from: string, to: string): Promise<void> {
  const source = await safeWorkspacePath(root, from);
  const target = await safeWorkspacePath(root, to);
  if (source === target) return;
  try {
    await fs.access(target);
    throw new Error('toast.fileExists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
}

export async function deleteProjectEntry(root: string, relative: string): Promise<void> {
  const fullPath = await safeWorkspacePath(root, relative);
  await fs.rm(fullPath, { recursive: true, force: false });
}

/** A folder becomes a Blode project area once it contains this marker file. */
export const PROJECT_MARKER = 'be';

export async function ensureProjectMarker(root: string): Promise<void> {
  const marker = await safeWorkspacePath(root, PROJECT_MARKER);
  try {
    await fs.readFile(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.writeFile(marker, '', 'utf8');
  }
}

export async function loadProjectConfig(root: string, fallback: ProjectConfig): Promise<ProjectConfig> {
  return (await loadProjectDescriptor(root, fallback)).config;
}

export interface LoadedProject {
  config: ProjectConfig;
  build: ProjectBuild;
}

/** `be` is the source of truth; `.blode/project.json` remains for older projects. */
export async function loadProjectDescriptor(
  root: string,
  fallback: ProjectConfig,
): Promise<LoadedProject> {
  await fs.mkdir(root, { recursive: true });
  const marker = await safeWorkspacePath(root, PROJECT_MARKER);
  try {
    const text = await fs.readFile(marker, 'utf8');
    if (text.trim()) {
      try {
        return parseProjectDescriptor(JSON.parse(text));
      } catch {
        throw new Error('error.invalidProjectDescriptor');
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const file = await safeWorkspacePath(root, '.blode/project.json', { internal: true });
  try {
    return {
      config: parseConfig(JSON.parse(await fs.readFile(file, 'utf8'))),
      build: {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await persistConfig(root, fallback);
    return { config: fallback, build: {} };
  }
}

export async function persistConfig(root: string, config: ProjectConfig): Promise<void> {
  const marker = await safeWorkspacePath(root, PROJECT_MARKER);
  let markerExists = false;
  let build: unknown;
  try {
    const text = await fs.readFile(marker, 'utf8');
    markerExists = true;
    if (text.trim()) build = (JSON.parse(text) as { build?: unknown }).build;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = await safeWorkspacePath(root, '.blode/project.json.tmp', { internal: true });
  await fs.mkdir(path.dirname(temporary), { recursive: true });
  if (markerExists) {
    const payload = { ...config, ...(build ? { build } : {}) };
    await fs.writeFile(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await fs.rename(temporary, marker);
    return;
  }
  const file = await safeWorkspacePath(root, '.blode/project.json', { internal: true });
  await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

/** Inventory covers every regular project file, including assets that the editor cannot open. */
export async function scanProjectInventory(
  root: string,
  editablePaths: ReadonlySet<string>,
  limits = { entries: 5000, depth: 32 },
): Promise<ProjectInventory> {
  const inventory: ProjectInventory = {
    entries: [],
    totalBytes: 0,
    fileCount: 0,
    directoryCount: 0,
    truncated: false,
  };
  async function walk(directory: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      inventory.truncated = true;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      if (inventory.entries.length >= limits.entries) {
        inventory.truncated = true;
        return;
      }
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath).replaceAll('\\', '/');
      try {
        const stat = await fs.lstat(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          inventory.entries.push({ path: relative, kind: 'directory', size: 0, editable: false });
          inventory.directoryCount++;
          if (depth + 1 >= limits.depth) {
            if ((await fs.readdir(fullPath)).some((name) => !ignored.has(name.toLowerCase())))
              inventory.truncated = true;
          } else await walk(fullPath, depth + 1);
        } else if (stat.isFile()) {
          inventory.entries.push({
            path: relative,
            kind: 'file',
            size: stat.size,
            editable: editablePaths.has(relative),
          });
          inventory.fileCount++;
          inventory.totalBytes += stat.size;
        }
      } catch {
        inventory.truncated = true;
      }
    }
  }
  await walk(root, 0);
  return inventory;
}

/** Debounced native events refresh externally created files/folders without polling. */
export function watchWorkspace(
  root: string,
  onChange: () => void,
  onError?: (error: Error) => void,
): () => void {
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      const parts = filename?.toString().replaceAll('\\', '/').split('/') ?? [];
      if (parts.some((part) => ignored.has(part.toLowerCase()))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!closed) onChange();
      }, 250);
      timer.unref();
    });
    watcher.on('error', (error) => {
      if (!closed) onError?.(error);
    });
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
