import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getBoardAdapter } from '../extensions/registry';
import { LanguageNavigationService } from '../src/core/language-navigation';
import {
  compilerArguments,
  compilerIncludeArguments,
  getCompilerIncludeRoots,
} from '../src/core/compiler-includes';
import { languageNavigationSchema } from '../src/core/language-schemas';

async function fixture(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-source-navigation-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'),
    sdk = path.join(base, 'SDK & headers');
  await fs.mkdir(root);
  await fs.mkdir(sdk);
  const config = getBoardAdapter('STM32F103C8T6').createConfig();
  let current = root;
  const files = [
    { path: 'main.c', language: 'c', content: '#include <driver.h>\nint main(void) { return drive(); }\n' },
  ];
  await fs.writeFile(
    path.join(root, 'compile_commands.json'),
    JSON.stringify([{ directory: root, file: 'main.c', arguments: ['gcc', '-I', sdk, '-c', 'main.c'] }]),
  );
  await fs.writeFile(
    path.join(sdk, 'driver.h'),
    '#include "detail.h"\nint drive(void);\n#define DRIVER_ENABLED 1\n',
  );
  await fs.writeFile(
    path.join(sdk, 'detail.h'),
    'int drive(void) { return 42; }\n// drive() is documented\nconst char *text = "drive";\n',
  );
  const core = {
    workspaceSnapshot: async () => ({ projectRoot: current, files }),
    currentConfig: () => config,
    currentProjectRoot: () => current,
  };
  const service = new LanguageNavigationService({ core, toolchainRoot: path.join(base, 'tools'), env: {} });
  return {
    base,
    root,
    sdk,
    service,
    core,
    files,
    config,
    switch: () => {
      current = path.join(base, 'other');
    },
  };
}

test('compiler include metadata handles spaces, response prefixes and separate system include flags', () => {
  const cwd = path.resolve('project');
  assert.deepEqual(
    compilerArguments('gcc -I"../SDK headers/include" -isystem "../system headers" -c main.c'),
    ['gcc', '-I../SDK headers/include', '-isystem', '../system headers', '-c', 'main.c'],
  );
  assert.deepEqual(
    compilerIncludeArguments(
      [
        '-I',
        '../SDK headers',
        '-isystem',
        '../system',
        '-iprefix',
        '../idf/include',
        '-iwithprefixbefore',
        'log/include',
      ],
      cwd,
    ),
    [
      path.resolve(cwd, '../SDK headers'),
      path.resolve(cwd, '../system'),
      path.resolve(cwd, '../idf/include/log/include'),
    ],
  );
  assert.equal(
    languageNavigationSchema.safeParse({
      expectedProjectRoot: cwd,
      path: 'main.c',
      kind: 'include',
      specifier: 'esp_log.h',
    }).success,
    true,
  );
  assert.equal(
    languageNavigationSchema.safeParse({ expectedProjectRoot: cwd, path: 'main.c', kind: 'definition' })
      .success,
    false,
  );
});

test('external includes open as virtual read-only sources, and declarations/definitions/references traverse their headers', async (t) => {
  const f = await fixture(t);
  const [target] = await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'include',
    specifier: 'driver.h',
  });
  assert.match(target.path, /^@external\/[a-f0-9]{32}\/driver\.h$/);
  assert.ok(target.externalId);
  const source = await f.service.openExternal({
    expectedProjectRoot: f.root,
    externalId: target.externalId!,
  });
  assert.equal(source.readonly, true);
  assert.equal(source.displayPath, path.join(f.sdk, 'driver.h'));
  assert.equal(source.path, target.path);
  const recursive = await f.service.navigate({
    expectedProjectRoot: f.root,
    path: target.path,
    externalId: target.externalId,
    kind: 'include',
    specifier: 'detail.h',
  });
  assert.match(recursive[0].path, /\/detail\.h$/);
  const declaration = await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'declaration',
    symbol: 'drive',
  });
  assert.equal(declaration[0].line, 2);
  assert.match(declaration[0].path, /\/driver\.h$/);
  const definition = await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'definition',
    symbol: 'drive',
  });
  assert.equal(definition[0].line, 1);
  assert.match(definition[0].path, /\/detail\.h$/);
  const references = await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'reference',
    symbol: 'drive',
  });
  assert.equal(references.length, 3, 'declaration, definition and call count; comment and string do not');
  assert.ok(references.some((item) => item.path === 'main.c'));
  assert.ok(references.filter((item) => item.externalId).length === 2);
  f.files[0].content += '\n#define MODIFIED 1';
  assert.equal(
    (
      await f.service.navigate({
        expectedProjectRoot: f.root,
        path: target.path,
        externalId: target.externalId,
        kind: 'include',
        specifier: 'detail.h',
      })
    ).length,
    1,
    'opened source capabilities survive a workspace reindex',
  );
});

test('named child targets discover their own build records, compiler choices and external read-only headers', async (t) => {
  const f = await fixture(t),
    automatic = getBoardAdapter('auto').createConfig();
  await fs.rm(path.join(f.root, 'compile_commands.json'));
  const child = path.join(f.root, 'Controller'),
    nested = path.join(child, '.blode/targets/control/build');
  const targetTools = path.join(f.base, 'Target GNU'),
    targetSdk = path.join(f.base, 'Target SDK');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(path.join(targetTools, 'include'), { recursive: true });
  await fs.mkdir(targetSdk);
  await fs.writeFile(path.join(targetTools, 'include', 'target_api.h'), 'int target_only(void);\n');
  await fs.writeFile(path.join(targetSdk, 'vendor.h'), '#include "detail.h"\nint vendor_drive(void);\n');
  await fs.writeFile(path.join(targetSdk, 'detail.h'), 'int vendor_drive(void) { return 73; }\n');
  await fs.writeFile(
    path.join(nested, 'compile_commands.json'),
    JSON.stringify([
      { directory: child, file: 'main.c', arguments: ['gcc', '-I', targetSdk, '-c', 'main.c'] },
    ]),
  );
  f.files.splice(
    0,
    f.files.length,
    {
      path: 'be',
      language: 'json',
      content: JSON.stringify({
        ...automatic,
        build: {
          targets: [
            {
              id: 'control',
              name: 'Controller',
              root: 'Controller',
              build: {
                settings: {
                  platforms: { STM32F103C8T6: { c: { family: 'gnu-arm', directory: targetTools } } },
                },
              },
            },
          ],
        },
      }),
    },
    {
      path: 'Controller/be',
      language: 'json',
      content: JSON.stringify({ ...f.config, build: { entry: 'main.c' } }),
    },
    {
      path: 'Controller/main.c',
      language: 'cpp',
      content: '#include "vendor.h"\n#include "target_api.h"\nint main(void){return vendor_drive();}',
    },
  );
  const records = [
    { root: child, buildDirectory: '.blode/targets/control/build', success: true, stale: false },
  ];
  const core = {
    ...f.core,
    currentConfig: () => automatic,
    buildEvidenceState: async () => ({ success: false, stale: false, records }),
  };
  const service = new LanguageNavigationService({
    core,
    toolchainRoot: path.join(f.base, 'emptytools'),
    env: {},
  });
  const [vendor] = await service.navigate({
    expectedProjectRoot: f.root,
    path: 'Controller/main.c',
    kind: 'include',
    specifier: 'vendor.h',
  });
  assert.ok(vendor?.externalId, 'nested target compiler metadata provides its SDK include path');
  const source = await service.openExternal({ expectedProjectRoot: f.root, externalId: vendor.externalId! });
  assert.equal(source.readonly, true);
  assert.equal(source.displayPath, path.join(targetSdk, 'vendor.h'));
  assert.ok(service.readonlyPaths(f.root).includes(source.path));
  const [standard] = await service.navigate({
    expectedProjectRoot: f.root,
    path: 'Controller/main.c',
    kind: 'include',
    specifier: 'target_api.h',
  });
  assert.equal(
    (await service.openExternal({ expectedProjectRoot: f.root, externalId: standard.externalId! }))
      .displayPath,
    path.join(targetTools, 'include', 'target_api.h'),
  );
  const [definition] = await service.navigate({
    expectedProjectRoot: f.root,
    path: 'Controller/main.c',
    kind: 'definition',
    symbol: 'vendor_drive',
  });
  assert.match(definition.path, /\/detail\.h$/);
  // Metadata still supports navigation before the first successful compilation exists.
  const noEvidence = new LanguageNavigationService({
    core: f.core,
    toolchainRoot: path.join(f.base, 'emptytools'),
    env: {},
  });
  assert.ok(
    (
      await noEvidence.navigate({
        expectedProjectRoot: f.root,
        path: 'Controller/main.c',
        kind: 'include',
        specifier: 'vendor.h',
      })
    )[0]?.externalId,
  );
});

test('duplicate headers remain selectable and external reads reject forged IDs, traversal, symlinks and stale projects', async (t) => {
  const f = await fixture(t),
    second = path.join(f.base, 'second SDK');
  await fs.mkdir(second);
  await fs.writeFile(path.join(second, 'driver.h'), '#define ANOTHER_DRIVER 1\n');
  await fs.writeFile(
    path.join(f.root, 'compile_commands.json'),
    JSON.stringify([{ directory: f.root, arguments: ['gcc', '-I', f.sdk, '-I', second] }]),
  );
  const targets = await f.service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.c',
    kind: 'include',
    specifier: 'driver.h',
  });
  assert.equal(targets.length, 2);
  assert.notEqual(targets[0].externalId, targets[1].externalId);
  await assert.rejects(
    f.service.openExternal({ expectedProjectRoot: f.root, externalId: '0'.repeat(32) }),
    /languageSourceExpired/,
  );
  await assert.rejects(
    f.service.navigate({
      expectedProjectRoot: f.root,
      path: '../outside.c',
      kind: 'definition',
      symbol: 'drive',
    }),
    /invalidPath/,
  );
  assert.deepEqual(
    await f.service.navigate({
      expectedProjectRoot: f.root,
      path: 'main.c',
      kind: 'include',
      specifier: '../../outside.h',
    }),
    [],
  );
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'escape.h'), '#define SECRET 1');
  try {
    await fs.symlink(outside, path.join(f.sdk, 'private'), 'junction');
    assert.deepEqual(
      await f.service.navigate({
        expectedProjectRoot: f.root,
        path: 'main.c',
        kind: 'include',
        specifier: 'private/escape.h',
      }),
      [],
    );
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  f.switch();
  await assert.rejects(
    f.service.openExternal({ expectedProjectRoot: f.root, externalId: targets[0].externalId! }),
    /collaborationProjectChanged/,
  );
  await assert.rejects(
    f.service.navigate({
      expectedProjectRoot: f.root,
      path: 'main.c',
      kind: 'include',
      specifier: 'driver.h',
    }),
    /collaborationProjectChanged/,
  );
});

test('the installed ESP32-S3 SDK resolves esp_log.h with the selected chip include flags', async (t) => {
  const tools = path.resolve('tools'),
    header = path.join(
      tools,
      'arduino-data/packages/esp32/tools/esp32-arduino-libs/idf-release_v5.1-632e0c2a/esp32s3/include/log/include/esp_log.h',
    );
  if (!(await fs.stat(header).catch(() => null)))
    return t.skip('ESP32 SDK is not installed on this test host');
  const f = await fixture(t),
    config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  const files = [
    {
      path: 'main.ino',
      language: 'cpp',
      content: '#include <esp_log.h>\nvoid setup() { ESP_LOGI("app", "ready"); }\nvoid loop() {}',
    },
  ];
  const core = {
    currentProjectRoot: () => f.root,
    currentConfig: () => config,
    workspaceSnapshot: async () => ({ projectRoot: f.root, files }),
  };
  const roots = await getCompilerIncludeRoots({
    workspace: await core.workspaceSnapshot(),
    config,
    toolchainRoot: tools,
    env: {},
  });
  assert.ok(roots.some((root) => path.resolve(root) === path.dirname(header)));
  assert.ok(
    !roots.some((root) => /esp32s2[\\/]include/.test(root)),
    'other chip SDK include trees are excluded',
  );
  const service = new LanguageNavigationService({ core, toolchainRoot: tools, env: {} });
  const targets = await service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.ino',
    kind: 'include',
    specifier: 'esp_log.h',
  });
  assert.equal(targets.length, 1);
  const opened = await service.openExternal({
    expectedProjectRoot: f.root,
    externalId: targets[0].externalId!,
  });
  assert.equal(opened.displayPath, header);
  assert.match(opened.content, /ESP_LOGI/);
  const macros = await service.navigate({
    expectedProjectRoot: f.root,
    path: 'main.ino',
    kind: 'definition',
    symbol: 'ESP_LOGI',
  });
  assert.ok(
    macros.some((item) => item.externalId === targets[0].externalId && item.line > 1),
    'macro navigation reaches the installed header definition',
  );
});
