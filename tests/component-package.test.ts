import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ComponentPackages, readComponentPackage } from '../src/core/component-package';
import { ComponentLibraries, readComponentManifest, COMPONENT_MANIFEST_FILE } from '../src/core/components';
import { readComponentZip } from '../src/core/component-zip';
import { writeZip } from '../src/core/zip';
import { getBoardAdapter } from '../extensions/registry';
import type { ManagedComponentLibrary } from '../src/shared/components';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-component-package-'));
  const source = path.join(base, 'source'),
    target = path.join(base, 'target'),
    dataRoot = path.join(base, 'data');
  await Promise.all([source, target, dataRoot].map((root) => fs.mkdir(root)));
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.match(path.basename(base), /^blode-component-package-/);
    await fs.rm(base, { recursive: true, force: true });
  });
  const libraries: ManagedComponentLibrary[] = [];
  const add = async (
    name: string,
    files: Record<string, string>,
    dependencies: string[] = [],
    includes = ['src'],
  ) => {
    const prefix = `components/${name}`;
    const library: ManagedComponentLibrary = {
      id: `component-${hash(name).slice(0, 16)}`,
      name,
      kind: 'c',
      version: '1.2.0',
      path: prefix,
      source: { type: 'directory' },
      dependencies,
      includes: includes.map((file) => `${prefix}/${file}`),
      sources: Object.keys(files)
        .filter((file) => file.endsWith('.c'))
        .map((file) => `${prefix}/${file}`),
      integrity: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, hash(text)])),
    };
    for (const [file, text] of Object.entries(files)) {
      const full = path.join(source, prefix, file);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, text);
    }
    libraries.push(library);
    await fs.writeFile(
      path.join(source, COMPONENT_MANIFEST_FILE),
      JSON.stringify({ version: 1, components: libraries }),
    );
    return library;
  };
  const main = await add(
    'Display',
    { 'src/display.c': 'int display(void){return 1;}', 'config/display.h': '#pragma once' },
    ['Bus (>=1.0.0)'],
    ['config'],
  );
  const bus = await add('Bus', { 'src/bus.c': 'int bus(void){return 2;}', 'src/bus.h': '#pragma once' }, [
    'Clock (>=1.0.0)',
  ]);
  const clock = await add('Clock', {
    'src/clock.c': 'int clock(void){return 3;}',
    'src/clock.h': '#pragma once',
  });
  await add('Unused', { 'src/unused.c': 'int unused(void){return 0;}' });
  let current = source;
  const packages = new ComponentPackages({ dataRoot, projectRoot: () => current });
  const imported = new ComponentLibraries({
    projectRoot: () => target,
    config: () => getBoardAdapter('STM32F103C8T6').createConfig(),
    dataRoot,
    toolchainRoot: path.join(base, 'tools'),
    fetcher: async () => {
      throw Error('unexpected network');
    },
  });
  const archive = async () => {
    const result = await packages.export({ expectedProjectRoot: source, ids: [main.id], confirm: true });
    return { result, file: packages.download(result.id).path };
  };
  return {
    base,
    source,
    target,
    dataRoot,
    libraries,
    main,
    bus,
    clock,
    packages,
    imported,
    archive,
    switchProject: () => {
      current = target;
    },
  };
}

test('selected component exports recursively include managed dependencies and preserve custom build inputs', async (t) => {
  const f = await fixture(t),
    { result, file } = await f.archive();
  assert.equal(result.componentCount, 3);
  assert.deepEqual(result.dependencies, []);
  const payloads = readComponentPackage(readComponentZip(await fs.readFile(file)))!;
  assert.deepEqual(
    payloads.map((item) => item.library.name),
    ['Display', 'Bus', 'Clock'],
  );
  assert.deepEqual(payloads[0].library.includes, ['components/Display/config']);
  assert.deepEqual(payloads[0].library.sources, ['components/Display/src/display.c']);
  const imported = await f.imported.importArchive(file, f.target);
  assert.deepEqual(
    imported.components.map((item) => item.name),
    ['Display', 'Bus', 'Clock'],
  );
  assert.deepEqual(imported.components[0].includes, f.main.includes);
  assert.equal(
    await fs.readFile(path.join(f.target, 'components/Display/config/display.h'), 'utf8'),
    '#pragma once',
  );
});

test('component sharing hashes the current edited source rather than the original import integrity', async (t) => {
  const f = await fixture(t),
    changed = 'int display(void){return 42;}';
  await fs.writeFile(path.join(f.source, 'components/Display/src/display.c'), changed);
  const { file } = await f.archive();
  const payloads = readComponentPackage(readComponentZip(await fs.readFile(file)))!;
  assert.equal(payloads[0].library.integrity['src/display.c'], hash(changed));
  assert.notEqual(payloads[0].library.integrity['src/display.c'], f.main.integrity['src/display.c']);
  await f.imported.importArchive(file, f.target);
  assert.equal(await fs.readFile(path.join(f.target, 'components/Display/src/display.c'), 'utf8'), changed);
});

test('custom empty include directories round trip, while missing directories reject export', async (t) => {
  const f = await fixture(t);
  const empty = 'components/Display/generated';
  await fs.mkdir(path.join(f.source, empty));
  f.main.includes.push(empty);
  await fs.writeFile(
    path.join(f.source, COMPONENT_MANIFEST_FILE),
    JSON.stringify({ version: 1, components: f.libraries }),
  );
  const { file } = await f.archive();
  const payloads = readComponentPackage(readComponentZip(await fs.readFile(file)))!;
  assert.ok(payloads[0].directories?.includes('generated'));
  await f.imported.importArchive(file, f.target);
  assert.equal((await fs.stat(path.join(f.target, empty))).isDirectory(), true);
  assert.ok((await readComponentManifest(f.target)).components[0].includes.includes(empty));
  await fs.rmdir(path.join(f.source, empty));
  await assert.rejects(f.archive(), /componentChanged/);
});

test('tampered component payloads fail before any package member is imported', async (t) => {
  const f = await fixture(t),
    { file } = await f.archive();
  const files = readComponentZip(await fs.readFile(file));
  files.set('components/Display/src/display.c', Buffer.from('tampered source'));
  const tampered = path.join(f.base, 'tampered.zip');
  await writeZip(
    tampered,
    (async function* () {
      for (const [name, data] of files) yield { path: name, data };
    })(),
  );
  await assert.rejects(f.imported.importArchive(tampered, f.target), /componentChecksum/);
  assert.deepEqual((await readComponentManifest(f.target)).components, []);
  assert.equal(await fs.stat(path.join(f.target, 'components/Display')).catch(() => undefined), undefined);
});

test('failure during the second component promotion rolls back the entire imported package', async (t) => {
  const f = await fixture(t),
    { file } = await f.archive();
  let promotions = 0;
  await assert.rejects(
    f.imported.importArchive(file, f.target, {
      progress: (progress) => {
        if (progress.phase === 'installing' && ++promotions === 2) throw Error('fixture promotion failure');
      },
    }),
    /fixture promotion failure/,
  );
  assert.deepEqual((await readComponentManifest(f.target)).components, []);
  for (const name of ['Display', 'Bus', 'Clock'])
    assert.equal(await fs.stat(path.join(f.target, 'components', name)).catch(() => undefined), undefined);
});

test('component export and import refuse stale project roots', async (t) => {
  const f = await fixture(t),
    { file } = await f.archive();
  f.switchProject();
  await assert.rejects(
    f.packages.export({ expectedProjectRoot: f.source, ids: [f.main.id], confirm: true }),
    /projectChanged/,
  );
  await assert.rejects(f.imported.importArchive(file, f.source), /componentProjectChanged/);
  assert.deepEqual((await readComponentManifest(f.target)).components, []);
});

test('component export reports an incompatible managed dependency before producing a package', async (t) => {
  const f = await fixture(t);
  f.bus.version = '0.5.0';
  await fs.writeFile(
    path.join(f.source, COMPONENT_MANIFEST_FILE),
    JSON.stringify({ version: 1, components: f.libraries }),
  );
  await assert.rejects(f.archive(), /componentDependencyConflict/);
  assert.equal(await fs.stat(path.join(f.dataRoot, 'exports')).catch(() => undefined), undefined);
});
