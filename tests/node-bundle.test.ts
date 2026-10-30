import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { nodeLanguageAssetsPlugin } from '../scripts/node-json-assets.mjs';

test('MCP bridge schemas do not load board adapters, compilers or language catalogs', async () => {
  const result = await build({
    entryPoints: ['scripts/mcp-bridge.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    minify: true,
    keepNames: true,
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.deepEqual(
    inputs.filter(
      (file) => file.startsWith('extensions/boards/') && /\/(?:device|compiler|languages)\//.test(file),
    ),
    [],
  );
  assert.ok(!inputs.includes('src/core/workspace.ts'));
  assert.ok(result.outputFiles[0].contents.length < 90_000, 'the bridge should contain protocol and schemas');
});

test('Node language tables preserve JSON values and independent version/module objects', async () => {
  const files = [
    'extensions/boards/Esp32_S3_CAM/languages/C/c17/catalog.json',
    'extensions/boards/STM32F103C8T6/languages/C/c17/catalog.json',
  ];
  const result = await build({
    stdin: {
      contents: `import a from './${files[0]}';import b from './${files[1]}';export const tables=[a,b];`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    minify: true,
    write: false,
    plugins: [nodeLanguageAssetsPlugin()],
  });
  const module = { exports: {} as { tables?: Record<string, unknown>[] } };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(
    module,
    module.exports,
    createRequire(import.meta.url),
  );
  const tables = module.exports.tables!;
  for (let index = 0; index < files.length; index++)
    assert.deepEqual(tables[index], JSON.parse(await readFile(files[index], 'utf8')));
  assert.notEqual(tables[0], tables[1]);
  tables[0].testMutation = true;
  assert.equal(tables[1].testMutation, undefined);
  assert.ok(result.outputFiles[0].contents.length < 12_000, 'large catalogs use compact Node data');
});

test('main keeps runtime dependencies external and a bounded entry without dropping host features', async () => {
  const result = await build({
    entryPoints: ['src/core/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron', 'serialport', 'node-pty', 'zod'],
    minify: true,
    keepNames: true,
    write: false,
    metafile: true,
    plugins: [nodeLanguageAssetsPlugin()],
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(!inputs.some((file) => file.startsWith('node_modules/zod/')));
  assert.ok(inputs.includes('src/core/model-service/index.ts'));
  assert.ok(inputs.includes('src/core/general-extensions/index.ts'));
  assert.ok(inputs.includes('src/core/hardware-debugger.ts'));
  assert.ok(result.outputFiles[0].contents.length < 1_000_000);
});
