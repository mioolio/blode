export type AssetKind = 'image' | 'audio' | 'video' | 'binary';
export interface WorkspaceAssetRequest {
  expectedProjectRoot: string;
  path: string;
}
export interface WorkspaceAssetPreview {
  path: string;
  kind: AssetKind;
  mime: string;
  size: number;
  modifiedAt: string;
  url: string;
  /** Bounded hexadecimal prefix for formats without a native viewer. */
  hex?: string;
  truncated?: boolean;
}

const formats: Record<string, [AssetKind, string]> = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  webp: ['image', 'image/webp'],
  avif: ['image', 'image/avif'],
  svg: ['image', 'image/svg+xml'],
  tif: ['image', 'image/tiff'],
  tiff: ['image', 'image/tiff'],
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  wave: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg'],
  flac: ['audio', 'audio/flac'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  aif: ['audio', 'audio/aiff'],
  aiff: ['audio', 'audio/aiff'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
  mov: ['video', 'video/quicktime'],
  mkv: ['video', 'video/x-matroska'],
  avi: ['video', 'video/x-msvideo'],
};
const extension = (value: string) => /\.([^.\\/]+)$/.exec(value)?.[1]?.toLowerCase() ?? '';
export const assetKind = (file: string): AssetKind => formats[extension(file)]?.[0] ?? 'binary';
export const assetMime = (file: string): string =>
  formats[extension(file)]?.[1] ?? 'application/octet-stream';
