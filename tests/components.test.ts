import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ComponentLibraries, ARDUINO_LIBRARY_INDEX_URL, readComponentManifest } from '../src/core/components';
import { componentVersionMatches, resolveComponentDependencies } from '../src/core/component-dependencies';
import { writeZip } from '../src/core/zip';
import { getBoardAdapter } from '../extensions/registry';
import type { ComponentInstallRequest } from '../src/shared/components';
import type { ProjectBuildInputs } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-components-test-'));
  const project = path.join(root, 'project'),
    source = path.join(root, 'My Component'),
    data = path.join(root, 'data'),
    tools = path.join(root, 'tools');
  await Promise.all([project, source, data, tools].map((directory) => fs.mkdir(directory)));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^blode-components-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  let current = project;
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  const options = { projectRoot: () => current, dataRoot: data, toolchainRoot: tools, config: () => config };
  const put = async (directory: string, name: string, value: string) => {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  let counter = 0;
  const zip = async (files: Record<string, string>) => {
    const file = path.join(root, `archive-${counter++}.zip`);
    await writeZip(
      file,
      (async function* () {
        for (const [name, body] of Object.entries(files)) yield { path: name, data: Buffer.from(body) };
      })(),
    );
    return { file, bytes: await fs.readFile(file) };
  };
  const records: any[] = [];
  const archives = new Map<string, Buffer>();
  const requests: string[] = [];
  const release = async (
    name: string,
    version: string,
    dependencies: { name: string; version?: string }[] = [],
    propertiesDepends?: string,
  ) => {
    const folder = name.replaceAll(' ', '_');
    const { bytes } = await zip({
      [`${folder}/library.properties`]: `name=${name}\nversion=${version}\ndepends=${propertiesDepends ?? dependencies.map((d) => d.name + (d.version ? ` (${d.version})` : '')).join(',')}\n`,
      [`${folder}/src/${folder}.h`]: '#pragma once\n',
      [`${folder}/src/${folder}.cpp`]: 'int library_entry(){return 1;}\n',
      [`${folder}/examples/demo/demo.ino`]: 'void setup(){}\n',
    });
    const url = `https://downloads.arduino.cc/libraries/test/${folder}-${version}.zip`;
    records.push({
      name,
      version,
      url,
      size: bytes.length,
      checksum: 'SHA-256:' + createHash('sha256').update(bytes).digest('hex'),
      dependencies,
      author: 'Fixture',
      sentence: 'Fixture library',
    });
    archives.set(url, bytes);
    return url;
  };
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === ARDUINO_LIBRARY_INDEX_URL)
      return new Response(gzipSync(JSON.stringify({ libraries: records })));
    const archive = archives.get(url);
    return new Response(archive ? new Uint8Array(archive) : 'not found', { status: archive ? 200 : 404 });
  };
  const request = (name: string, version: string): ComponentInstallRequest => ({
    name,
    version,
    confirm: true,
    expectedProjectRoot: project,
  });
  return {
    root,
    project,
    source,
    data,
    tools,
    config,
    options,
    put,
    zip,
    release,
    records,
    archives,
    requests,
    fetcher,
    request,
    setProject: (value: string) => {
      current = value;
    },
  };
}

test('local C components remain project-contained and expose source/include build inputs without tools', async (t) => {
  const f = await fixture(t);
  await f.put(f.source, 'src/value.c', 'int value(){return 1;}');
  await f.put(f.source, 'include/value.h', 'int value(void);');
  await f.put(f.source, 'examples/main.c', 'int main(){}');
  await f.put(f.source, 'install.ps1', 'throw "must never run"');
  await f.put(f.source, '.git/config', 'private');
  const service = new ComponentLibraries({
    ...f.options,
    fetcher: async () => {
      throw Error('offline');
    },
    runner: async () => {
      throw Error('must never execute');
    },
  });
  const state = await service.importDirectory(f.source, f.project);
  assert.equal(state.components.length, 1);
  const library = state.components[0];
  assert.equal(library.kind, 'c');
  assert.deepEqual(library.sources, ['components/My_Component/src/value.c']);
  assert.ok(library.includes.includes('components/My_Component/include'));
  assert.equal(
    await fs.readFile(path.join(f.project, library.path, 'install.ps1'), 'utf8'),
    'throw "must never run"',
  );
  assert.equal(await fs.stat(path.join(f.project, library.path, '.git')).catch(() => null), null);
  assert.equal('integrity' in library, false);
  assert.ok(Object.keys((await readComponentManifest(f.project)).components[0].integrity).length >= 4);
  await assert.rejects(service.importDirectory(f.source, f.project), /componentExists/);
});

test('local Arduino ZIP wrapper imports recursively compiled src and preserves library.properties', async (t) => {
  const f = await fixture(t);
  const { file } = await f.zip({
    'Servo/library.properties': 'name=Servo\nversion=1.2\n',
    'Servo/src/Servo.h': '#pragma once',
    'Servo/src/nested/Servo.cpp': 'int servo;',
    'Servo/examples/main.ino': 'void setup(){}',
  });
  const state = await new ComponentLibraries(f.options).importArchive(file, f.project);
  assert.equal(state.components[0].kind, 'arduino');
  assert.equal(state.components[0].version, '1.2');
  assert.deepEqual(state.components[0].includes, ['libraries/Servo/src']);
  assert.deepEqual(state.components[0].sources, ['libraries/Servo/src/nested/Servo.cpp']);
});

test('official catalog exposes selectable versions and resolves recursive shared version constraints', async (t) => {
  const f = await fixture(t);
  await f.release('Parent', '1.0.0', [{ name: 'Base', version: '>=1.0.0' }, { name: 'Nested' }]);
  await f.release('Base', '1.0.0');
  await f.release('Base', '2.0.0');
  await f.release('Nested', '1.0.0', [{ name: 'Base', version: '<2.0.0' }]);
  const service = new ComponentLibraries({ ...f.options, fetcher: f.fetcher });
  const found = await service.search('Base');
  assert.deepEqual(found.entries[0].versions, ['2.0.0', '1.0.0']);
  const state = await service.install(f.request('Parent', '1.0.0'));
  assert.equal(state.components.length, 3);
  assert.equal(state.components.find((item) => item.name === 'Base')?.version, '1.0.0');
  assert.deepEqual(state.components.find((item) => item.name === 'Nested')?.dependencies, ['Base (<2.0.0)']);
  assert.equal(f.requests.filter((url) => url === ARDUINO_LIBRARY_INDEX_URL).length, 1);
  await assert.rejects(
    service.remove({
      id: state.components.find((item) => item.name === 'Base')!.id,
      confirm: true,
      expectedProjectRoot: f.project,
    }),
    /componentInUse/,
  );
});

test('library.properties dependencies missing from an index record are recursively installed', async (t) => {
  const f = await fixture(t);
  await f.release('Parent', '1.0.0', [], 'ActualDependency (>=2.0.0)');
  await f.release('ActualDependency', '2.0.0');
  const state = await new ComponentLibraries({ ...f.options, fetcher: f.fetcher }).install(
    f.request('Parent', '1.0.0'),
  );
  assert.deepEqual(state.components.map((item) => item.name).sort(), ['ActualDependency', 'Parent']);
});

test('checksum or dependency failure leaves no partial import and never overwrites existing folders', async (t) => {
  const f = await fixture(t);
  const url = await f.release('Parent', '1.0.0', [{ name: 'Missing' }]);
  const service = new ComponentLibraries({ ...f.options, fetcher: f.fetcher });
  await assert.rejects(service.install(f.request('Parent', '1.0.0')), /componentDependency/);
  assert.deepEqual((await service.list()).components, []);
  assert.equal(await fs.stat(path.join(f.project, 'libraries')).catch(() => null), null);
  f.records[0].dependencies = [];
  f.archives.set(url, Buffer.alloc(f.archives.get(url)!.length));
  await assert.rejects(
    new ComponentLibraries({
      ...f.options,
      dataRoot: path.join(f.root, 'fresh'),
      fetcher: f.fetcher,
    }).install(f.request('Parent', '1.0.0')),
    /componentChecksum/,
  );
  await f.put(f.source, 'own.c', 'int own;');
  await f.put(f.project, 'components/My_Component/user.txt', 'keep');
  await assert.rejects(service.importDirectory(f.source, f.project), /componentExists/);
  assert.equal(await fs.readFile(path.join(f.project, 'components/My_Component/user.txt'), 'utf8'), 'keep');
});

test('project switches during a download cannot write either old or newly selected project', async (t) => {
  const f = await fixture(t);
  const url = await f.release('Delayed', '1.0.0');
  const next = path.join(f.root, 'next');
  await fs.mkdir(next);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = new ComponentLibraries({
    ...f.options,
    fetcher: async (input, init) => {
      if (String(input) === url) {
        started();
        await pending;
      }
      return f.fetcher(input, init);
    },
  });
  const installation = service.install(f.request('Delayed', '1.0.0'));
  await seen;
  f.setProject(next);
  release();
  await assert.rejects(installation, /componentProjectChanged/);
  for (const directory of [f.project, next])
    assert.equal(await fs.stat(path.join(directory, 'blode.components.json')).catch(() => null), null);
  await assert.rejects(service.importDirectory(f.source, f.project), /componentProjectChanged/);
});

test('removal rejects edited or additional files, then removes only an unchanged imported component', async (t) => {
  const f = await fixture(t);
  await f.put(f.source, 'value.h', '#pragma once');
  const service = new ComponentLibraries(f.options);
  const state = await service.importDirectory(f.source, f.project);
  const library = state.components[0];
  const request = { id: library.id, confirm: true as const, expectedProjectRoot: f.project };
  const target = path.join(f.project, library.path);
  await f.put(target, 'value.h', 'changed');
  await assert.rejects(service.remove(request), /componentChanged/);
  assert.equal(await fs.readFile(path.join(target, 'value.h'), 'utf8'), 'changed');
  await f.put(target, 'value.h', '#pragma once');
  await f.put(target, '.env', 'user-added secret');
  await assert.rejects(service.remove(request), /componentChanged/);
  await fs.unlink(path.join(target, '.env'));
  assert.deepEqual((await service.remove(request)).components, []);
  assert.equal(await fs.stat(target).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(f.source, 'value.h'), 'utf8'), '#pragma once');
});

test('core-provided libraries are displayed separately and satisfy unversioned dependencies without downloading', async (t) => {
  const f = await fixture(t);
  await f.put(
    f.tools,
    'arduino-data/packages/esp32/hardware/esp32/3.0.7/libraries/Wire/library.properties',
    'name=Wire\nversion=3.0.7\n',
  );
  await f.release('UsesWire', '1.0.0', [{ name: 'Wire' }]);
  const service = new ComponentLibraries({ ...f.options, fetcher: f.fetcher });
  assert.equal((await service.list()).provided[0].name, 'Wire');
  const result = await service.install(f.request('UsesWire', '1.0.0'));
  assert.equal(result.components.length, 1);
  await assert.rejects(service.install(f.request('Wire', '1.0.0')), /componentProvided/);
});

test('local Arduino imports resolve missing dependencies and preserve existing project versions', async (t) => {
  const f = await fixture(t);
  await f.release('Helper', '1.0.0');
  await f.put(f.source, 'library.properties', 'name=Local\nversion=1.0.0\ndepends=Helper (>=1.0.0)\n');
  await f.put(f.source, 'src/Local.h', '#pragma once');
  const service = new ComponentLibraries({ ...f.options, fetcher: f.fetcher });
  await service.install(f.request('Helper', '1.0.0'));
  const before = f.requests.length;
  const state = await service.importDirectory(f.source, f.project);
  assert.equal(state.components.length, 2);
  assert.equal(f.requests.length, before);
});

test('core-provided libraries follow platform/C++ version and package-store overrides', async (t) => {
  const f = await fixture(t);
  const core = 'arduino-data/packages/esp32/hardware/esp32';
  for (const version of ['2.0.17', '3.0.7'])
    await f.put(
      f.tools,
      `${core}/${version}/libraries/Wire/library.properties`,
      `name=Wire\nversion=${version}\n`,
    );
  const custom = path.join(f.root, 'custom-store');
  await f.put(custom, `${core}/1.0.0/libraries/Wire/library.properties`, 'name=Wire\nversion=1.0.0\n');
  let build: ProjectBuildInputs = {
    settings: {
      common: { family: 'arduino', version: '3.0.7' },
      platforms: { Esp32_S3_CAM: { cpp: { family: 'inherit', version: '2.0.17' } } },
    },
  };
  const service = new ComponentLibraries({ ...f.options, build: () => build });
  assert.equal((await service.list()).provided[0].version, '2.0.17');
  build = { settings: { common: { family: 'arduino', packageDirectory: custom, version: '1.0.0' } } };
  assert.equal((await service.list()).provided[0].version, '1.0.0');
  f.config.toolchain.packageDirectory = custom;
  build = { settings: { common: { family: 'auto' } } };
  assert.equal((await service.list()).provided[0].version, '3.0.7');
  build = { settings: { common: { family: 'arduino', version: '9.9.9' } } };
  assert.equal((await service.list()).provided.length, 0);
  build = { settings: { common: { family: 'arduino', version: '2.0.17' } } };
  await f.put(
    f.tools,
    `versions/arduino-esp32/2.0.17/${core}/2.0.17/libraries/Versioned/library.properties`,
    'name=Versioned\nversion=2.0.17\n',
  );
  assert.equal((await service.list()).provided[0].name, 'Versioned');
});

test('project library versions take precedence over same-name core libraries when resolving dependencies', async (t) => {
  const f = await fixture(t);
  await f.put(f.source, 'library.properties', 'name=Wire\nversion=1.0.0\n');
  await f.put(f.source, 'src/Wire.h', '#pragma once');
  const service = new ComponentLibraries({ ...f.options, fetcher: f.fetcher });
  await service.importDirectory(f.source, f.project);
  await f.put(
    f.tools,
    'arduino-data/packages/esp32/hardware/esp32/3.0.7/libraries/Wire/library.properties',
    'name=Wire\nversion=2.0.0\n',
  );
  await f.release('NeedsNewWire', '1.0.0', [{ name: 'Wire', version: '>=2.0.0' }]);
  await assert.rejects(service.install(f.request('NeedsNewWire', '1.0.0')), /componentDependency/);
  const state = await service.list();
  assert.equal(state.components.length, 1);
  assert.equal(state.components[0].version, '1.0.0');
  assert.equal(state.provided[0].version, '2.0.0');
});

test('manifest rejects paths escaping managed directories while imported source may be edited for builds', async (t) => {
  const f = await fixture(t);
  await f.put(f.source, 'value.c', 'int value;');
  const service = new ComponentLibraries(f.options);
  const state = await service.importDirectory(f.source, f.project);
  await f.put(f.project, state.components[0].sources[0], 'int edited;');
  assert.equal((await readComponentManifest(f.project)).components.length, 1);
  const file = path.join(f.project, 'blode.components.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.components[0].sources = ['../outside.c'];
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(readComponentManifest(f.project), /componentManifest/);
});

test('manifest expansion beyond the read limit rolls back import without replacing the previous manifest', async (t) => {
  const f = await fixture(t);
  await f.put(f.source, 'value.h', '#pragma once');
  const service = new ComponentLibraries(f.options);
  const state = await service.importDirectory(f.source, f.project);
  const file = path.join(f.project, 'blode.components.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.components[0].integrity = Object.fromEntries(
    Array.from({ length: 10000 }, (_, index) => [
      'x'.repeat(758) + index.toString().padStart(4, '0'),
      '0'.repeat(64),
    ]),
  );
  const before = JSON.stringify(manifest);
  assert.ok(Buffer.byteLength(before) < 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(manifest, null, 2)) > 8 * 1024 * 1024);
  await fs.writeFile(file, before);
  const other = path.join(f.root, 'Other');
  await f.put(other, 'other.h', '#pragma once');
  await assert.rejects(service.importDirectory(other, f.project), /componentTooLarge/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(await fs.stat(path.join(f.project, 'components/Other')).catch(() => null), null);
  assert.equal((await service.list()).components[0].id, state.components[0].id);
});

test('Arduino constraint expressions support grouping, negation, prerelease and reject unsupported syntax', () => {
  assert.equal(componentVersionMatches('2.0.0', '>1.0.0 && <2.1.0'), true);
  assert.equal(componentVersionMatches('2.1.0', '(>=1.0.0 && <2.0.0) || =2.1.0'), true);
  assert.equal(componentVersionMatches('1.0.0', '!=1.0.0'), false);
  assert.equal(componentVersionMatches('1.2.0', '!(<1.0.0 || >2.0.0)'), true);
  assert.equal(componentVersionMatches('1.0.0-beta.2', '<1.0.0'), true);
  for (const constraint of ['^1.0.0', '>=1.0.0 ||', '(>=1.0.0', 'name'])
    assert.throws(() => componentVersionMatches('1.0.0', constraint), /componentDependency|componentVersion/);
  const catalog = new Map([
    ['a', [{ name: 'A', version: '1.0.0', dependencies: [{ name: 'B', constraint: '' }] }]],
    ['b', [{ name: 'B', version: '1.0.0', dependencies: [{ name: 'A', constraint: '=1.0.0' }] }]],
  ]);
  assert.equal(resolveComponentDependencies(catalog, [{ name: 'A', constraint: '' }], new Map()).length, 2);
});

test('public index cache survives offline reuse without extending its age, and corrupt caches are replaced', async (t) => {
  const f = await fixture(t);
  await f.release('Cached', '1.0.0');
  await new ComponentLibraries({ ...f.options, fetcher: f.fetcher }).search('Cached');
  const cache = path.join(f.data, 'component-cache/arduino-library-index.gz');
  const old = new Date(Date.now() - 3600000);
  await fs.utimes(cache, old, old);
  const before = (await fs.stat(cache)).mtimeMs;
  const offline = new ComponentLibraries({
    ...f.options,
    fetcher: async () => {
      throw Error('offline');
    },
  });
  assert.equal((await offline.search('Cached')).entries[0].name, 'Cached');
  assert.equal((await fs.stat(cache)).mtimeMs, before);
  await fs.writeFile(cache, 'broken gzip');
  assert.equal(
    (await new ComponentLibraries({ ...f.options, fetcher: f.fetcher }).search('Cached')).entries.length,
    1,
  );
  assert.equal(f.requests.filter((url) => url === ARDUINO_LIBRARY_INDEX_URL).length, 2);
});

test('removal rejects a linked managed parent even when the alias points within the project', async (t) => {
  const f = await fixture(t);
  await f.put(f.source, 'value.h', '#pragma once');
  const service = new ComponentLibraries(f.options);
  const state = await service.importDirectory(f.source, f.project),
    library = state.components[0];
  const parent = path.join(f.project, 'components'),
    actual = path.join(f.project, 'different');
  await fs.rename(parent, actual);
  try {
    await fs.symlink(actual, parent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Symlink permission unavailable');
      return;
    }
    throw error;
  }
  await assert.rejects(
    service.remove({ id: library.id, confirm: true, expectedProjectRoot: f.project }),
    /componentPath/,
  );
  assert.equal(await fs.readFile(path.join(actual, 'My_Component/value.h'), 'utf8'), '#pragma once');
});

test(
  'Windows transient rename locks recover for importing and removing components',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    await f.put(f.source, 'value.h', '#pragma once');
    const service = new ComponentLibraries(f.options);
    const original = fs.rename.bind(fs);
    const attempts = new Map<string, number>();
    t.mock.method(fs, 'rename', async (source: string, destination: string) => {
      const phase = source.includes('components-import-')
        ? 'import'
        : path.basename(source).startsWith('.blode-components-')
          ? 'manifest'
          : destination.includes('components-remove-')
            ? 'remove'
            : '';
      const count = attempts.get(phase) ?? 0;
      attempts.set(phase, count + 1);
      if (phase && count < 2)
        throw Object.assign(new Error('temporary scan lock'), {
          code: phase === 'remove' ? 'EACCES' : 'EPERM',
        });
      return original(source, destination);
    });
    const state = await service.importDirectory(f.source, f.project);
    assert.equal(state.components.length, 1);
    assert.equal(
      (await service.remove({ id: state.components[0].id, expectedProjectRoot: f.project, confirm: true }))
        .components.length,
      0,
    );
    assert.equal(attempts.get('import'), 3);
    assert.equal(attempts.get('remove'), 3);
  },
);

test(
  'Windows persistent manifest rename locks roll back imports and restore removals',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    await f.put(f.source, 'value.h', '#pragma once');
    const service = new ComponentLibraries(f.options);
    const original = fs.rename.bind(fs);
    let fail = true,
      restoreAttempts = 0;
    t.mock.method(fs, 'rename', async (source: string, destination: string) => {
      if (fail && path.basename(source).startsWith('.blode-components-'))
        throw Object.assign(new Error('persistent scan lock'), { code: 'EPERM' });
      if (path.basename(source).startsWith('components-remove-') && ++restoreAttempts === 1)
        throw Object.assign(new Error('restore scan lock'), { code: 'EBUSY' });
      return original(source, destination);
    });
    await assert.rejects(service.importDirectory(f.source, f.project), /persistent scan lock/);
    assert.equal(await fs.stat(path.join(f.project, 'components/My_Component')).catch(() => null), null);
    assert.equal(await fs.stat(path.join(f.project, 'blode.components.json')).catch(() => null), null);
    fail = false;
    const state = await service.importDirectory(f.source, f.project),
      component = state.components[0];
    fail = true;
    await assert.rejects(
      service.remove({ id: component.id, expectedProjectRoot: f.project, confirm: true }),
      /persistent scan lock/,
    );
    assert.equal(restoreAttempts, 2);
    assert.equal(
      await fs.readFile(path.join(f.project, component.sources[0] ?? component.path + '/value.h'), 'utf8'),
      '#pragma once',
    );
    assert.equal((await service.list()).components.length, 1);
  },
);

test(
  'Windows retry refuses a target directory created during a rename lock',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    await f.put(f.source, 'value.h', '#pragma once');
    const original = fs.rename.bind(fs);
    let collision = false;
    t.mock.method(fs, 'rename', async (source: string, destination: string) => {
      if (!collision && source.includes('components-import-')) {
        collision = true;
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, 'user.txt'), 'user data');
        throw Object.assign(new Error('temporary scan lock'), { code: 'EPERM' });
      }
      return original(source, destination);
    });
    await assert.rejects(
      new ComponentLibraries(f.options).importDirectory(f.source, f.project),
      /componentExists/,
    );
    assert.equal(
      await fs.readFile(path.join(f.project, 'components/My_Component/user.txt'), 'utf8'),
      'user data',
    );
  },
);
