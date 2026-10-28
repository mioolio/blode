import {
  Binary,
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';

interface FileVisual {
  icon: LucideIcon;
  tone: string;
}

/** Extension-driven icon and colour; unknown files stay neutral rather than guessing a type. */
const visuals: Record<string, FileVisual> = {
  ino: { icon: FileCode, tone: 'tone-code' },
  c: { icon: FileCode, tone: 'tone-code' },
  cc: { icon: FileCode, tone: 'tone-code' },
  cpp: { icon: FileCode, tone: 'tone-code' },
  cxx: { icon: FileCode, tone: 'tone-code' },
  h: { icon: FileType, tone: 'tone-header' },
  hh: { icon: FileType, tone: 'tone-header' },
  hpp: { icon: FileType, tone: 'tone-header' },
  ts: { icon: FileCode, tone: 'tone-script' },
  tsx: { icon: FileCode, tone: 'tone-script' },
  js: { icon: FileCode, tone: 'tone-script' },
  jsx: { icon: FileCode, tone: 'tone-script' },
  py: { icon: FileCode, tone: 'tone-script' },
  sh: { icon: FileCode, tone: 'tone-script' },
  json: { icon: FileBraces, tone: 'tone-data' },
  jsonc: { icon: FileBraces, tone: 'tone-data' },
  csv: { icon: FileSpreadsheet, tone: 'tone-data' },
  yml: { icon: FileCog, tone: 'tone-config' },
  yaml: { icon: FileCog, tone: 'tone-config' },
  toml: { icon: FileCog, tone: 'tone-config' },
  ini: { icon: FileCog, tone: 'tone-config' },
  cfg: { icon: FileCog, tone: 'tone-config' },
  conf: { icon: FileCog, tone: 'tone-config' },
  md: { icon: FileText, tone: 'tone-doc' },
  txt: { icon: FileText, tone: 'tone-doc' },
  log: { icon: FileText, tone: 'tone-doc' },
  bin: { icon: Binary, tone: 'tone-binary' },
  hex: { icon: Binary, tone: 'tone-binary' },
  elf: { icon: Binary, tone: 'tone-binary' },
  uf2: { icon: Binary, tone: 'tone-binary' },
  png: { icon: FileImage, tone: 'tone-image' },
  jpg: { icon: FileImage, tone: 'tone-image' },
  jpeg: { icon: FileImage, tone: 'tone-image' },
  gif: { icon: FileImage, tone: 'tone-image' },
  svg: { icon: FileImage, tone: 'tone-image' },
  webp: { icon: FileImage, tone: 'tone-image' },
  ico: { icon: FileImage, tone: 'tone-image' },
  zip: { icon: FileArchive, tone: 'tone-archive' },
  gz: { icon: FileArchive, tone: 'tone-archive' },
  tar: { icon: FileArchive, tone: 'tone-archive' },
  rar: { icon: FileArchive, tone: 'tone-archive' },
  '7z': { icon: FileArchive, tone: 'tone-archive' },
};

const fallback: FileVisual = { icon: File, tone: 'tone-neutral' };

export function fileVisual(name: string): FileVisual {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return visuals[extension] ?? fallback;
}

export function FileIcon({ name, size = 15 }: { name: string; size?: number }) {
  const { icon: Icon, tone } = fileVisual(name);
  return <Icon className={`file-icon ${tone}`} size={size} strokeWidth={1.7} aria-hidden="true" />;
}

export function FolderIcon({ open, size = 15 }: { open: boolean; size?: number }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon className="file-icon tone-folder" size={size} strokeWidth={1.7} aria-hidden="true" />;
}
