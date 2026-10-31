/**
 * Fetch the pinned clangd release into tools/clangd for local development and
 * full packaging. Lite packages omit this folder and install clangd from
 * Preferences on the target machine instead.
 *
 *   npm run fetch:clangd
 */
import path from 'node:path';
import { installClangd } from '../src/core/clangd/install';
import { CLANGD_VERSION, clangdRelease } from '../src/core/clangd/manifest';

const directory = path.resolve('tools', 'clangd');
const release = clangdRelease(process.platform, process.arch);
if (!release) {
  console.error(`clangd ${CLANGD_VERSION} has no standalone build for ${process.platform}-${process.arch}.`);
  process.exit(1);
}
console.log(`Downloading ${release.downloadUrl}`);
await installClangd({
  directory,
  onProgress: (progress) => {
    if (progress.phase === 'downloading' && progress.totalBytes)
      process.stdout.write(`\r${Math.round(((progress.receivedBytes ?? 0) / progress.totalBytes) * 100)}%`);
    else if (progress.phase !== 'downloading') process.stdout.write(`\n${progress.phase}\n`);
  },
});
console.log(`clangd ${CLANGD_VERSION} installed at ${directory}`);
