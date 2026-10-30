import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDependencyFile } from '../src/core/build-dependencies';
import { collectProjectPackage, ProjectPackages } from '../src/core/project-package';
import { saveBuildState, hashArtifacts } from '../src/core/build-state';
import { readComponentZip } from '../src/core/component-zip';
import { runCommand } from '../src/core/process';
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-build-package-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project'),
    data = path.join(root, 'data'),
    external = path.join(root, 'external headers');
  await Promise.all([project, data, external].map((file) => fs.mkdir(file)));
  await fs.mkdir(path.join(project, '.blode', 'build'), { recursive: true });
  return { root, project, data, external };
}
async function success(project: string) {
  const artifact = '.blode/build/firmware.bin';
  if (!(await fs.stat(path.join(project, artifact)).catch(() => null)))
    await fs.writeFile(path.join(project, artifact), 'firmware');
  await saveBuildState(project, {
    version: 1,
    sourceFingerprint: 'a'.repeat(64),
    artifactHashes: await hashArtifacts(project, [artifact]),
    result: {
      success: true,
      flashUsed: 8,
      flashTotal: 65536,
      ramUsed: 0,
      ramTotal: 20480,
      artifacts: [artifact],
      timestamp: new Date(Date.now() + 1000).toISOString(),
      output: '',
    },
  });
}
test('Make dependency parsing handles Windows drive letters, escaped spaces and continuations', () => {
  assert.deepEqual(
    parseDependencyFile('C:/build/main.o: C:/source/main.c C:/SDK\\ files/a.h \\\n C\\:/board/b.h\n'),
    ['C:/source/main.c', 'C:/SDK files/a.h', 'C:/board/b.h'],
  );
});
test('fresh build evidence resolves external and macro headers; stale evidence is not copied', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.project, 'main.c'),
    '#define CONFIG "board.h"\n#include CONFIG\nint main(void){return VALUE;}\n',
  );
  await fs.writeFile(path.join(f.external, 'board.h'), '#define VALUE 42\n');
  await fs.writeFile(
    path.join(f.project, '.blode', 'build', 'main.d'),
    `main.o: ${path.join(f.project, 'main.c').replaceAll('\\', '/')} ${path.join(f.external, 'board.h').replaceAll('\\', '/').replaceAll(' ', '\\ ')}\n`,
  );
  await success(f.project);
  const fresh = await collectProjectPackage(f.project, { buildEvidence: { success: true, stale: false } });
  assert.equal(fresh.plan.externalCount, 1);
  assert.equal(fresh.plan.warnings.length, 0);
  const stale = await collectProjectPackage(f.project, { buildEvidence: { success: true, stale: true } });
  assert.equal(stale.plan.externalCount, 0);
  assert.ok(stale.plan.warnings.some((w) => w.reason === 'build-evidence-stale'));
  assert.ok(stale.plan.warnings.some((w) => w.reason === 'macro-include'));
});
test('build-provided SDK headers are requirements, not missing project files or copied toolchains', async (t) => {
  const f = await fixture(t),
    tools = path.join(f.root, 'tools'),
    sdk = path.join(
      tools,
      'arduino-data',
      'packages',
      'esp32',
      'hardware',
      'esp32',
      '3.0.7',
      'cores',
      'esp32',
    );
  await fs.mkdir(sdk, { recursive: true });
  await fs.writeFile(path.join(sdk, 'esp_log.h'), '#pragma once\n');
  await fs.writeFile(path.join(f.project, 'main.c'), '#include <esp_log.h>\n');
  await fs.writeFile(
    path.join(f.project, '.blode', 'build', 'main.d'),
    `main.o: ${path.join(f.project, 'main.c').replaceAll('\\', '/')} ${path.join(sdk, 'esp_log.h').replaceAll('\\', '/')}\n`,
  );
  await success(f.project);
  const result = await collectProjectPackage(f.project, { toolchainRoots: [tools] });
  assert.equal(result.plan.externalCount, 0);
  assert.equal(result.plan.warnings.length, 0);
  assert.ok(result.plan.toolRequirements.includes('arduino-core:esp32:esp32@3.0.7'));
});
test('a real compiled Arm project rebuilds from its ZIP after its external headers move away', async (t) => {
  const suffix = process.platform === 'win32' ? '.exe' : '',
    directory = path.resolve('tools/versions/gnu-arm/15.2.1-1.1/bin'),
    gcc = path.join(directory, 'arm-none-eabi-gcc' + suffix),
    objcopy = path.join(directory, 'arm-none-eabi-objcopy' + suffix);
  if (!(await fs.stat(gcc).catch(() => null))?.isFile())
    return t.skip('managed GNU Arm compiler is unavailable');
  const f = await fixture(t);
  if (process.platform === 'win32') {
    const labels = await runCommand(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
      [f.root, '/setintegritylevel', '(OI)(CI)L', '/T'],
    );
    assert.equal(labels.code, 0, labels.output);
  }
  await fs.writeFile(path.join(f.external, 'detail.h'), '#define ANSWER 43\n');
  await fs.writeFile(path.join(f.external, 'board.h'), '#include "detail.h"\n');
  await fs.writeFile(path.join(f.project, 'main.c'), '#include "board.h"\nint main(void){return ANSWER;}\n');
  await fs.writeFile(path.join(f.project, 'be'), JSON.stringify({ build: { entry: 'main.c' } }));
  const compile = async (root: string, includes: string[]) => {
    const out = path.join(root, '.blode', 'build');
    await fs.mkdir(out, { recursive: true });
    const object = path.join(out, 'main.o'),
      elf = path.join(out, 'firmware.elf'),
      bin = path.join(out, 'firmware.bin');
    for (const [command, args] of [
      [
        gcc,
        [
          '-mcpu=cortex-m3',
          '-mthumb',
          ...includes.flatMap((dir) => ['-I', dir]),
          '-MD',
          '-MF',
          path.join(out, 'main.d'),
          '-c',
          path.join(root, 'main.c'),
          '-o',
          object,
        ],
      ],
      [
        gcc,
        [
          '-mcpu=cortex-m3',
          '-mthumb',
          '-nostdlib',
          '-Wl,-e,main',
          '-Wl,-Ttext=0x08000000',
          object,
          '-o',
          elf,
        ],
      ],
      [objcopy, ['-O', 'binary', elf, bin]],
    ] as const) {
      const result = await runCommand(command, [...args], {
        cwd: root,
        timeout: 60000,
        env: { TMP: out, TEMP: out, TMPDIR: out },
      });
      assert.equal(result.code, 0, result.output);
    }
    return fs.readFile(bin);
  };
  const original = await compile(f.project, [f.external]);
  await success(f.project);
  const manager = new ProjectPackages({
    dataRoot: f.data,
    projectRoot: () => f.project,
    toolchainRoots: () => [path.dirname(directory)],
  });
  const result = await manager.export({ expectedProjectRoot: f.project, confirmExternal: true });
  const files = readComponentZip(await fs.readFile(manager.file(result.id).path));
  const relocated = path.join(f.root, 'relocated');
  await fs.mkdir(relocated);
  for (const [name, data] of files) {
    const relative = name.slice(name.indexOf('/') + 1);
    const target = path.join(relocated, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
  await fs.rename(f.external, f.external + '-unavailable');
  const rebuilt = await compile(relocated, []);
  assert.deepEqual(rebuilt, original);
});

test('named build targets contribute only their fresh dependency records', async (t) => {
  const f = await fixture(t),
    child = path.join(f.project, 'controller'),
    namespace = '.blode/targets/control';
  await fs.mkdir(path.join(child, namespace, 'build'), { recursive: true });
  await fs.writeFile(path.join(child, 'main.c'), '#include "board.h"\n');
  await fs.writeFile(path.join(f.external, 'board.h'), '#define BOARD 1\n');
  await fs.writeFile(
    path.join(child, namespace, 'build', 'main.d'),
    `main.o: ${path.join(child, 'main.c').replaceAll('\\', '/')} ${path.join(f.external, 'board.h').replaceAll('\\', '/').replaceAll(' ', '\\ ')}\n`,
  );
  const artifact = namespace + '/build/firmware.bin';
  await fs.writeFile(path.join(child, artifact), 'target');
  await saveBuildState(
    child,
    {
      version: 1,
      sourceFingerprint: 'b'.repeat(64),
      artifactHashes: await hashArtifacts(child, [artifact]),
      result: {
        success: true,
        flashUsed: 6,
        flashTotal: 65536,
        ramUsed: 0,
        ramTotal: 20480,
        artifacts: [artifact],
        timestamp: new Date(Date.now() + 1000).toISOString(),
        output: '',
      },
    },
    namespace + '/build-state.json',
  );
  const status = {
    success: false,
    stale: false,
    records: [{ root: child, buildDirectory: namespace + '/build', success: true, stale: false }],
  };
  const fresh = await collectProjectPackage(f.project, { buildEvidence: status });
  assert.equal(fresh.plan.externalCount, 1);
  assert.equal(fresh.plan.warnings.length, 0);
  assert.match(fresh.content.get(path.join(child, 'main.c'))!.toString(), /\.\.\/dependencies\//);
  status.records[0].stale = true;
  const stale = await collectProjectPackage(f.project, { buildEvidence: status });
  assert.equal(stale.plan.externalCount, 0);
  assert.ok(stale.plan.warnings.some((item) => item.reason === 'build-evidence-stale'));
});

test('different translation units retain their actual same-named header and constant macro includes', async (t) => {
  const f = await fixture(t),
    second = path.join(f.root, 'second');
  await fs.mkdir(second);
  await fs.writeFile(path.join(f.external, 'board.h'), '#define BOARD 1\n');
  await fs.writeFile(path.join(second, 'board.h'), '#define BOARD 2\n');
  for (const [name, directory] of [
    ['first', f.external],
    ['second', second],
  ]) {
    const source = path.join(f.project, name + '.c');
    await fs.writeFile(source, '#define CONFIG "board.h"\n#include CONFIG\n');
    await fs.writeFile(
      path.join(f.project, '.blode', 'build', name + '.d'),
      `main.o: ${source.replaceAll('\\', '/')} ${path.join(directory, 'board.h').replaceAll('\\', '/').replaceAll(' ', '\\ ')}\n`,
    );
  }
  await success(f.project);
  const packaged = await collectProjectPackage(f.project);
  assert.equal(packaged.plan.externalCount, 2);
  assert.equal(packaged.plan.warnings.length, 0);
  const first = packaged.content.get(path.join(f.project, 'first.c'))!.toString(),
    other = packaged.content.get(path.join(f.project, 'second.c'))!.toString();
  assert.notEqual(first, other);
  assert.ok(!first.includes('#include CONFIG'));
  assert.ok(!other.includes('#include CONFIG'));
});

test('known CMake and Make absolute dependency paths are rewritten in the exported copy', async (t) => {
  const f = await fixture(t),
    library = path.join(f.external, 'board.a');
  await fs.writeFile(library, 'archive');
  const original = `target_link_libraries(app PRIVATE "${library.replaceAll('\\', '/')}")\n`;
  await fs.writeFile(path.join(f.project, 'CMakeLists.txt'), original);
  await fs.writeFile(path.join(f.project, 'Makefile'), `LIB := "${library.replaceAll('\\', '/')}"\n`);
  await fs.writeFile(
    path.join(f.project, '.blode', 'build', 'link.rsp'),
    `"${library.replaceAll('\\', '/')}"`,
  );
  await success(f.project);
  const result = await collectProjectPackage(f.project);
  assert.equal(result.plan.externalCount, 1);
  assert.equal(result.plan.warnings.length, 0);
  assert.match(
    result.content.get(path.join(f.project, 'CMakeLists.txt'))!.toString(),
    /\$\{CMAKE_CURRENT_LIST_DIR\}\/dependencies\//,
  );
  assert.match(result.content.get(path.join(f.project, 'Makefile'))!.toString(), /BLODE_PACKAGE_DIR :=/);
  assert.equal(await fs.readFile(path.join(f.project, 'CMakeLists.txt'), 'utf8'), original);
});

test('target and child descriptors preserve logical compiler versions and remove host-only paths', async (t) => {
  const f = await fixture(t),
    child = path.join(f.project, 'controller');
  await fs.mkdir(child);
  const library = path.join(f.external, 'module.c');
  await fs.writeFile(library, 'int module(void){return 7;}');
  const config = {
    toolchain: {
      mode: 'custom',
      arduinoCli: 'C:/host/tools/cli.exe',
      python: 'C:/host/python.exe',
      armCompilerDirectory: 'C:/host/arm',
      additionalUrls: [],
      fqbn: '',
    },
    port: 'COM99',
    debugger: { gdbPath: 'C:/host/gdb.exe', port: 'COM99', serialNumber: 'HOST-DEBUG' },
    runtime: { deviceId: 'HOST-DEVICE' },
  };
  await fs.writeFile(
    path.join(f.project, 'be'),
    JSON.stringify({
      build: {
        targets: [
          {
            id: 'control',
            name: 'Control',
            root: 'controller',
            config,
            build: {
              files: [library],
              settings: {
                common: { family: 'gnu-arm', version: '15.2.1-1.1', directory: 'C:/host/compiler' },
              },
            },
          },
        ],
      },
    }),
  );
  await fs.writeFile(path.join(child, 'be'), JSON.stringify({ ...config, build: { files: [library] } }));
  const result = await collectProjectPackage(f.project),
    parent = JSON.parse(result.content.get(path.join(f.project, 'be'))!.toString()),
    nested = JSON.parse(result.content.get(path.join(child, 'be'))!.toString()),
    target = parent.build.targets[0];
  assert.equal(result.plan.externalCount, 1);
  assert.equal(result.plan.warnings.length, 0);
  assert.match(target.build.files[0], /^\.\.\/dependencies\//);
  assert.match(nested.build.files[0], /^\.\.\/dependencies\//);
  assert.equal(target.build.settings.common.version, '15.2.1-1.1');
  assert.equal(target.build.settings.common.directory, undefined);
  for (const descriptor of [target.config, nested]) {
    assert.equal(descriptor.toolchain.armCompilerDirectory, undefined);
    assert.equal(descriptor.toolchain.arduinoCli, '');
    assert.equal(descriptor.debugger.gdbPath, undefined);
    assert.equal(descriptor.port, '');
    assert.equal(descriptor.runtime.deviceId, undefined);
  }
});
