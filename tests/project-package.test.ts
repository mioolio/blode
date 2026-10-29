import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { collectProjectPackage, ProjectPackages } from '../src/core/project-package';
import { crc32, writeZip, type ZipEntry } from '../src/core/zip';

async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-package-'));
  const project = path.join(parent, 'project');
  const data = path.join(parent, 'data');
  await fs.mkdir(project);
  await fs.mkdir(data);
  const service = new ProjectPackages({ dataRoot: data, projectRoot: () => project });
  const cleanup = async () => {
    assert.equal(path.dirname(path.resolve(parent)), path.resolve(os.tmpdir()));
    assert.match(path.basename(parent), /^blode-package-/);
    await fs.rm(parent, { recursive: true, force: true });
  };
  return { parent, project, data, service, cleanup };
}

/** Read using the standard central-directory fields, independently inflating each local body. */
function zipFiles(bytes: Buffer): Map<string, Buffer> {
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  const count = bytes.readUInt16LE(bytes.length - 12);
  let cursor = bytes.readUInt32LE(bytes.length - 6);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 10), 8);
    assert.ok(bytes.readUInt16LE(cursor + 8) & 0x800);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30),
      commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.ok(!entries.has(name));
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const localName = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28);
    assert.equal(bytes.subarray(local + 30, local + 30 + localName).toString('utf8'), name);
    const start = local + 30 + localName + localExtra;
    const body = inflateRawSync(bytes.subarray(start, start + compressed));
    assert.equal(body.length, uncompressed);
    assert.equal(crc32(body), checksum);
    entries.set(name, body);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('standard UTF8 ZIP central records and deflate bodies validate against known CRC32', async () => {
  const context = await fixture();
  try {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    const target = path.join(context.data, 'standard.zip');
    async function* entries(): AsyncGenerator<ZipEntry> {
      yield { path: '工程/main.c', data: Buffer.from('int main(void) { return 0; }\n') };
      yield { path: '工程/empty.txt', data: Buffer.alloc(0) };
    }
    const size = await writeZip(target, entries());
    const bytes = await fs.readFile(target);
    assert.equal(size, bytes.length);
    const files = zipFiles(bytes);
    assert.match(files.get('工程/main.c')!.toString(), /return 0/);
    assert.equal(files.get('工程/empty.txt')!.length, 0);
  } finally {
    await context.cleanup();
  }
});

test('portable package gathers external includes and Keil inputs without modifying the source project', async () => {
  const context = await fixture();
  const external = path.join(context.parent, 'external');
  const source = '#include "../external/inc/board.h"\nint main(void) { return BOARD_PIN; }\n';
  const xml =
    '<Project><Targets><Target><TargetName>Target1</TargetName><TargetOption><TargetCommonOption><Device>STM32F103C8</Device></TargetCommonOption><TargetArmAds><Cads><VariousControls><IncludePath>../external/inc</IncludePath></VariousControls></Cads><LDads><ScatterFile>../external/layout.sct</ScatterFile></LDads></TargetArmAds></TargetOption><Groups><Group><Files><File><FileName>lib.c</FileName><FilePath>../external/src/lib.c</FilePath></File></Files></Group></Groups></Target></Targets></Project>';
  const descriptor = {
    version: 1,
    name: 'Shared',
    boardId: 'STM32F103C8T6',
    port: 'COM12',
    programmer: { serialNumber: 'ABC' },
    toolchain: {
      arduinoCli: '',
      python: '',
      armCompilerDirectory: path.join(context.parent, 'native-compiler'),
    },
    build: { entry: '.', files: ['../external/src/lib.c'] },
  };
  try {
    await fs.mkdir(path.join(external, 'inc'), { recursive: true });
    await fs.mkdir(path.join(external, 'src'));
    await fs.writeFile(path.join(external, 'inc', 'board.h'), '#include "detail.h"\n#define BOARD_PIN 7\n');
    await fs.writeFile(path.join(external, 'inc', 'detail.h'), '#define DETAIL 1\n');
    await fs.writeFile(
      path.join(external, 'src', 'lib.c'),
      '#include "board.h"\nint lib(void) { return DETAIL; }\n',
    );
    await fs.writeFile(path.join(external, 'layout.sct'), 'LR_IROM1 0x08000000 0x10000 {}\n');
    await fs.writeFile(path.join(context.project, 'main.c'), source);
    await fs.writeFile(path.join(context.project, 'Project.uvprojx'), xml);
    const marker = JSON.stringify(descriptor);
    await fs.writeFile(path.join(context.project, 'be'), marker);
    const plan = await context.service.preview();
    assert.equal(plan.warnings.length, 0);
    assert.equal(plan.externalCount, 4);
    await assert.rejects(() => context.service.export({}), /packageConfirmExternal/);
    const result = await context.service.export({ confirmExternal: true });
    const archive = zipFiles(await fs.readFile(context.service.file(result.id).path));
    const mapped = new Map(plan.files.map((file) => [file.source, `project/${file.destination}`]));
    const main = archive.get('project/main.c')!.toString();
    const include = /#include "([^"]+)"/.exec(main)![1];
    assert.ok(archive.has(path.posix.normalize(`project/${include}`)));
    assert.ok(!main.includes('../external'));
    const copiedXml = archive.get('project/Project.uvprojx')!.toString();
    for (const match of copiedXml.matchAll(/<(FilePath|ScatterFile)>([^<]+)<\/\1>/g))
      assert.ok(archive.has(path.posix.normalize(`project/${match[2]}`)));
    const copiedMarker = JSON.parse(archive.get('project/be')!.toString());
    assert.equal(copiedMarker.port, '');
    assert.equal(copiedMarker.programmer.serialNumber, '');
    assert.ok(!copiedMarker.toolchain.armCompilerDirectory);
    assert.ok(archive.has(`project/${copiedMarker.build.files[0]}`));
    const manifest = JSON.parse(archive.get('project/.blode-share/manifest.json')!.toString());
    assert.equal(manifest.portable, true);
    assert.ok(manifest.toolRequirements.includes('custom:armCompilerDirectory'));
    assert.equal(await fs.readFile(path.join(context.project, 'main.c'), 'utf8'), source);
    assert.equal(await fs.readFile(path.join(context.project, 'Project.uvprojx'), 'utf8'), xml);
    assert.equal(await fs.readFile(path.join(context.project, 'be'), 'utf8'), marker);
    assert.ok(archive.has(mapped.get(await fs.realpath(path.join(external, 'inc', 'detail.h')))!));
  } finally {
    await context.cleanup();
  }
});

test('missing dependencies block portable export by default and are declared in an explicit incomplete export', async () => {
  const context = await fixture();
  try {
    await fs.writeFile(path.join(context.project, 'main.c'), '#include "missing-project-header.h"\n');
    const plan = await context.service.preview();
    assert.ok(plan.warnings.some((warning) => warning.reference === 'missing-project-header.h'));
    await assert.rejects(() => context.service.export({}), /packageUnresolved/);
    const result = await context.service.export({ allowIncomplete: true });
    const archive = zipFiles(await fs.readFile(context.service.file(result.id).path));
    const manifest = JSON.parse(archive.get('project/.blode-share/manifest.json')!.toString());
    assert.equal(manifest.portable, false);
    assert.ok(manifest.warnings.length);
  } finally {
    await context.cleanup();
  }
});

test('portable build settings remove host paths at every scope and retain compiler family and version', async () => {
  const context = await fixture();
  const marker = {
    version: 1,
    name: 'Compiler choices',
    boardId: 'STM32F103C8T6',
    toolchain: { arduinoCli: '', python: '' },
    build: {
      entry: 'main.c',
      cStandard: 'c17',
      settings: {
        mode: 'debug',
        optimizeForSize: true,
        common: {
          family: 'gnu-arm',
          version: '15.2.1-1.1',
          directory: 'C:\\host\\tools\\versions\\gnu-arm\\15.2.1-1.1\\bin',
        },
        platforms: {
          STM32F103C8T6: {
            common: { family: 'inherit', directory: '/opt/private/compiler' },
            c: {
              family: 'gnu-arm',
              version: '14.2.1-1.1',
              directory: '/opt/tools/versions/gnu-arm/14.2.1-1.1/bin',
            },
            cpp: { family: 'gnu-arm', version: '13.3.1-1.1', directory: '\\\\build-host\\compiler\\bin' },
          },
          Esp32_S3_CAM: {
            common: {
              family: 'arduino',
              version: '3.0.7',
              arduinoCli: 'C:/private/tools/versions/arduino-cli/1.3.1/bin/arduino-cli.exe',
              packageDirectory: '/opt/tools/versions/arduino-esp32/3.0.7',
            },
            c: { family: 'auto', directory: 'C:/private/unused-c' },
            cpp: { family: 'inherit', packageDirectory: 'C:/private/unused-cpp' },
          },
        },
      },
    },
  };
  const original = JSON.stringify(marker);
  try {
    await fs.writeFile(path.join(context.project, 'main.c'), 'int main(void) { return 0; }\n');
    await fs.writeFile(path.join(context.project, 'be'), original);
    const result = await context.service.export({});
    const archive = zipFiles(await fs.readFile(context.service.file(result.id).path));
    const copied = JSON.parse(archive.get('project/be')!.toString());
    const settings = copied.build.settings;
    assert.equal(settings.mode, 'debug');
    assert.equal(settings.optimizeForSize, true);
    assert.deepEqual(settings.common, { family: 'gnu-arm', version: '15.2.1-1.1' });
    assert.deepEqual(settings.platforms.STM32F103C8T6.common, { family: 'inherit' });
    assert.deepEqual(settings.platforms.STM32F103C8T6.c, { family: 'gnu-arm', version: '14.2.1-1.1' });
    assert.deepEqual(settings.platforms.STM32F103C8T6.cpp, { family: 'gnu-arm', version: '13.3.1-1.1' });
    assert.deepEqual(settings.platforms['Esp32_S3_CAM'].common, {
      family: 'arduino',
      version: '3.0.7',
    });
    assert.deepEqual(settings.platforms['Esp32_S3_CAM'].c, { family: 'auto' });
    assert.deepEqual(settings.platforms['Esp32_S3_CAM'].cpp, { family: 'inherit' });
    const manifest = JSON.parse(archive.get('project/.blode-share/manifest.json')!.toString());
    assert.equal(manifest.portable, true);
    assert.ok(manifest.toolRequirements.includes('gnu-arm:15.2.1-1.1'));
    assert.ok(manifest.toolRequirements.includes('gnu-arm:14.2.1-1.1'));
    assert.ok(manifest.toolRequirements.includes('arduino-cli:1.3.1'));
    assert.ok(manifest.toolRequirements.includes('arduino-esp32:3.0.7'));
    assert.ok(manifest.toolRequirements.includes('compiler:platforms.STM32F103C8T6.cpp:gnu-arm:13.3.1-1.1'));
    assert.ok(
      manifest.toolRequirements.includes('custom:build.settings.platforms.STM32F103C8T6.cpp.directory'),
    );
    assert.ok(!archive.get('project/be')!.toString().includes('private'));
    assert.equal(await fs.readFile(path.join(context.project, 'be'), 'utf8'), original);
  } finally {
    await context.cleanup();
  }
});

test('package skips symlinked folders instead of recursively leaking unrelated files', async (t) => {
  const context = await fixture();
  try {
    const outside = path.join(context.parent, 'unrelated');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'private.txt'), 'not a dependency');
    try {
      await fs.symlink(
        outside,
        path.join(context.project, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Symlink privilege unavailable');
        return;
      }
      throw error;
    }
    const scanned = await collectProjectPackage(context.project);
    assert.ok(scanned.plan.warnings.some((warning) => warning.reason === 'symlink'));
    assert.ok(!scanned.plan.files.some((file) => file.source.endsWith('private.txt')));
    await assert.rejects(() => context.service.export({}), /packageUnresolved/);
  } finally {
    await context.cleanup();
  }
});

test('oversized project files are rejected before loading their contents', async () => {
  const context = await fixture();
  try {
    const file = path.join(context.project, 'large.bin');
    await fs.writeFile(file, '');
    await fs.truncate(file, 64 * 1024 * 1024 + 1);
    await assert.rejects(() => context.service.preview(), /packageTooLarge/);
  } finally {
    await context.cleanup();
  }
});

test('ZIP writer rejects traversal, platform absolute paths, dot segments and duplicate names', async () => {
  const context = await fixture();
  try {
    for (const [index, name] of [
      '../outside.c',
      '/root.c',
      'a\\b.c',
      'C:/outside.c',
      'x/./file.c',
    ].entries()) {
      async function* entries(): AsyncGenerator<ZipEntry> {
        yield { path: name, data: Buffer.from('x') };
      }
      await assert.rejects(() => writeZip(path.join(context.data, `${index}.zip`), entries()));
    }
    async function* duplicate(): AsyncGenerator<ZipEntry> {
      yield { path: 'a.c', data: Buffer.from('first') };
      yield { path: 'a.c', data: Buffer.from('second') };
    }
    await assert.rejects(() => writeZip(path.join(context.data, 'duplicate.zip'), duplicate()));
  } finally {
    await context.cleanup();
  }
});

test('generated package metadata never silently overwrites a source file with the same name', async () => {
  const context = await fixture();
  try {
    await fs.writeFile(path.join(context.project, 'SHARE-MANIFEST.json'), '{"user":"original"}');
    const result = await context.service.export({});
    const archive = zipFiles(await fs.readFile(context.service.file(result.id).path));
    assert.equal(archive.get('project/SHARE-MANIFEST.json')!.toString(), '{"user":"original"}');
    assert.ok(archive.has('project/.blode-share/manifest.json'));
    assert.equal(
      await fs.readFile(path.join(context.project, 'SHARE-MANIFEST.json'), 'utf8'),
      '{"user":"original"}',
    );
  } finally {
    await context.cleanup();
  }
});

test('uppercase source files and project angle includes retain a portable dependency graph', async () => {
  const context = await fixture();
  try {
    await fs.writeFile(path.join(context.project, 'BOARD.H'), '#define BOARD_VALUE 1\n');
    await fs.writeFile(
      path.join(context.project, 'MAIN.C'),
      '#include <BOARD.H>\nint value = BOARD_VALUE;\n',
    );
    const result = await context.service.export({});
    const archive = zipFiles(await fs.readFile(context.service.file(result.id).path));
    assert.ok(archive.has('project/BOARD.H'));
    assert.match(archive.get('project/MAIN.C')!.toString(), /#include "BOARD.H"/);
  } finally {
    await context.cleanup();
  }
});

test('macro include directives report unresolved dependencies instead of falsely declaring portability', async () => {
  const context = await fixture();
  try {
    await fs.writeFile(
      path.join(context.project, 'main.c'),
      '#define BOARD_HEADER "board.h"\n#include BOARD_HEADER\n',
    );
    const plan = await context.service.preview();
    assert.ok(plan.warnings.length);
    await assert.rejects(() => context.service.export({}), /packageUnresolved/);
  } finally {
    await context.cleanup();
  }
});

test(
  'Windows differently-cased Keil paths are rewritten using canonical source destinations',
  { skip: process.platform !== 'win32' },
  async () => {
    const context = await fixture();
    try {
      const external = path.join(context.parent, 'MixedLibrary');
      await fs.mkdir(external);
      await fs.writeFile(path.join(external, 'Source.C'), 'int library;\n');
      await fs.writeFile(
        path.join(context.project, 'Project.uvprojx'),
        '<Project><FilePath>../MIXEDLIBRARY/SOURCE.C</FilePath></Project>',
      );
      const result = await context.service.export({ confirmExternal: true });
      const archive = zipFiles(await fs.readFile(context.service.file(result.id).path));
      const copied = archive.get('project/Project.uvprojx')!.toString();
      const reference = /<FilePath>([^<]+)<\/FilePath>/.exec(copied)![1];
      assert.ok(!reference.includes('MIXEDLIBRARY'));
      assert.ok(archive.has(path.posix.normalize(`project/${reference}`)));
    } finally {
      await context.cleanup();
    }
  },
);
