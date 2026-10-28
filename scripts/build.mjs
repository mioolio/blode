import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: true, logLevel: 'info' };
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
