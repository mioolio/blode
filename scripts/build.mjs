import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { nodeLanguageAssetsPlugin } from './node-json-assets.mjs';
import { buildDeviceModules } from './build-device-modules.mjs';
import { stageArchiveTools } from './stage-archive-tools.mjs';
const output = process.env.BLODE_RELEASE_DIST || 'dist';
await buildDeviceModules(output);
await stageArchiveTools(output);

const development =
  process.env.BLODE_BUILD_MODE === 'development' ||
  (!process.env.BLODE_BUILD_MODE && process.env.npm_lifecycle_event === 'dev');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: true,
  // Preserve diagnostic function/class names even in the release bundle.
  keepNames: true,
  sourcemap: development ? 'linked' : false,
  sourcesContent: false,
  legalComments: 'eof',
  logLevel: 'info',
  plugins: [nodeLanguageAssetsPlugin()],
};
await build({
  ...common,
  entryPoints: ['src/core/main.ts'],
  outfile: path.join(output, 'main.cjs'),
  format: 'cjs',
  external: ['electron', 'serialport', 'node-pty', 'zod'],
});
await build({
  ...common,
  entryPoints: ['src/core/preload.ts'],
  outfile: path.join(output, 'preload.cjs'),
  format: 'cjs',
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: ['scripts/mcp-bridge.ts'],
  outfile: path.join(output, 'mcp-bridge.mjs'),
  format: 'esm',
  packages: 'external',
});
// A release made after a dev build must not package obsolete debug maps.
if (!development)
  await Promise.all(
    ['main.cjs', 'preload.cjs', 'mcp-bridge.mjs'].map((name) =>
      rm(path.join(output, name + '.map'), { force: true }),
    ),
  );
