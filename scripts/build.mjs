import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const development =
  process.env.BLODE_BUILD_MODE === 'development' ||
  (!process.env.BLODE_BUILD_MODE && process.env.npm_lifecycle_event === 'dev');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: !development,
  // Preserve diagnostic function/class names even in the release bundle.
  keepNames: true,
  sourcemap: development ? 'linked' : false,
  sourcesContent: false,
  legalComments: 'eof',
  logLevel: 'info',
};
await build({
  ...common,
  entryPoints: ['src/core/main.ts'],
  outfile: 'dist/main.cjs',
  format: 'cjs',
  external: ['electron', 'serialport'],
});
await build({
  ...common,
  entryPoints: ['src/core/preload.ts'],
  outfile: 'dist/preload.cjs',
  format: 'cjs',
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: ['scripts/mcp-bridge.ts'],
  outfile: 'dist/mcp-bridge.mjs',
  format: 'esm',
  packages: 'external',
});
// A release made after a dev build must not package obsolete debug maps.
if (!development)
  await Promise.all(
    ['main.cjs', 'preload.cjs', 'mcp-bridge.mjs'].map((name) => rm(`dist/${name}.map`, { force: true })),
  );
