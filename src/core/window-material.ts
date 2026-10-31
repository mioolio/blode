import os from 'node:os';

export type WindowMaterial = 'acrylic' | 'mica';

/** Electron's backgroundMaterial needs Windows 11 22H2 (build 22621) or newer. */
export function nativeWindowMaterial(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): WindowMaterial | undefined {
  if (platform !== 'win32') return undefined;
  const build = Number(release.split('.')[2]);
  return Number.isInteger(build) && build >= 22621 ? 'acrylic' : undefined;
}
