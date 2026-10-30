import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants } from 'node:zlib';

/** Keep each language version independent while avoiding large literal tables in Node entry points. */
export function nodeLanguageAssetsPlugin() {
  return {
    name: 'blode-node-language-assets',
    setup(build) {
      if (build.initialOptions.platform !== 'node')
        throw Error('Language asset compression requires a Node target.');
      build.onLoad({ filter: /\.json$/ }, async ({ path }) => {
        if (!/\/extensions\/boards\/[^/]+\/languages\//.test(path.replaceAll('\\', '/'))) return;
        const source = await readFile(path, 'utf8');
        const json = JSON.stringify(JSON.parse(source));
        const compressed = brotliCompressSync(Buffer.from(json), {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        });
        return {
          loader: 'js',
          contents: `import { brotliDecompressSync } from 'node:zlib';\nexport default JSON.parse(brotliDecompressSync(Buffer.from(${JSON.stringify(compressed.toString('base64'))},'base64')).toString('utf8'));`,
        };
      });
    },
  };
}
