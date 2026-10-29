import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rm } from 'node:fs/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/web-server.ts'],
  outfile: 'dist/web-server.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['serialport'],
  minify: true,
  keepNames: true,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'info',
});
const forbiddenInput = Object.keys(result.metafile.inputs).find((file) =>
  /(?:^|[\\/])node_modules[\\/](?:electron|@electron)(?:[\\/]|$)|(?:^|[\\/])src[\\/]core[\\/](?:main|preload)\.ts$/.test(
    file,
  ),
);
const forbiddenImport = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .find((item) => /^(?:electron|@electron)(?:\/|$)/.test(item.path));
if (forbiddenInput || forbiddenImport) {
  await rm(path.join(root, 'dist', 'web-server.cjs'), { force: true });
  throw new Error(`Web host must not include Electron: ${forbiddenInput || forbiddenImport.path}`);
}
await rm(path.join(root, 'dist', 'web-server.cjs.map'), { force: true });
await buildRenderer({ root });
console.log('Web build verified: the Node host contains no Electron imports.');
