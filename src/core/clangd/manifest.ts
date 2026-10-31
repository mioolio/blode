/** Pinned standalone clangd release published by the clangd project. */
export const CLANGD_VERSION = '23.1.0';

export interface ClangdRelease {
  version: string;
  asset: string;
  sha256: string;
  size: number;
  downloadUrl: string;
  releaseUrl: string;
  metadataUrl: string;
}

const releases: Record<string, { asset: string; sha256: string; size: number }> = {
  'win32-x64': {
    asset: 'clangd-windows-23.1.0.zip',
    sha256: '23412a240756a162e7b98a282f36aa2a23a88db5ce16a0cbc4fef7253768c810',
    size: 29690805,
  },
  'linux-x64': {
    asset: 'clangd-linux-23.1.0.zip',
    sha256: 'e53b1a96196095faedb7642cf64964f7fb9ad4a0c1f00dd2c172a3d9dcbafdfd',
    size: 117949007,
  },
  'darwin-x64': {
    asset: 'clangd-mac-23.1.0.zip',
    sha256: '1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253',
    size: 100060151,
  },
};

export function clangdExecutable(platform: NodeJS.Platform | string): string {
  return platform === 'win32' ? 'clangd.exe' : 'clangd';
}

export function clangdHostSupported(platform: NodeJS.Platform | string, arch: string): boolean {
  return Object.hasOwn(releases, `${platform}-${arch}`);
}

export function clangdRelease(platform: NodeJS.Platform | string, arch: string): ClangdRelease | undefined {
  const target = releases[`${platform}-${arch}`];
  if (!target) return undefined;
  return {
    version: CLANGD_VERSION,
    asset: target.asset,
    sha256: target.sha256,
    size: target.size,
    downloadUrl: `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}/${target.asset}`,
    releaseUrl: `https://github.com/clangd/clangd/releases/tag/${CLANGD_VERSION}`,
    metadataUrl: `https://api.github.com/repos/clangd/clangd/releases/tags/${CLANGD_VERSION}`,
  };
}
