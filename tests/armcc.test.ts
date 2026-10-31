import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { armccVersion } from '../src/shared/armcc';
import { parseProjectBuild } from '../src/core/config';
import { getBoardAdapter } from '../extensions/registry';
import { ToolVersions } from '../src/core/tool-versions';
import { OfflineTools } from '../src/core/tool-offline';
import { runCommand } from '../src/core/process';
import { createCore } from '../src/core/service';
import { prepareBuildExport } from '../src/core/firmware';

const versionText =
  'Product: ARM Compiler 5.06\nComponent: ARM Compiler 5.06 update 5 (build 528)\nTool: armcc';
test('AC5 versions retain update/build and the compiler choice validates independently', () => {
  assert.equal(armccVersion(versionText), '5.06-u5-b528');
  assert.equal(armccVersion('ARM Compiler 5.06'), '5.06');
  assert.equal(armccVersion('license failed'), '');
  const build = parseProjectBuild({
    entry: 'src',
    cStandard: 'c99',
    settings: { common: { family: 'armcc', version: '5.06-u5-b528' } },
  });
  assert.equal(build.settings?.common?.family, 'armcc');
});

test('AC5 inventory uses --vsn and exports/imports the runtime, headers and product metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-armcc-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools'),
    sdk = path.join(tools, 'versions/armcc/5.06-u5-b528');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const folder of ['bin', 'include', 'lib', 'sw/info'])
    await fs.mkdir(path.join(sdk, folder), { recursive: true });
  for (const name of ['armcc', 'armasm', 'armlink', 'fromelf', 'armar'])
    await fs.writeFile(path.join(sdk, 'bin', name + suffix), 'fixture tool');
  await fs.writeFile(path.join(sdk, 'bin/armcompiler_libFNP.dll'), 'runtime DLL');
  await fs.writeFile(path.join(sdk, 'include/stdint.h'), 'header');
  await fs.writeFile(path.join(sdk, 'lib/runtime.a'), 'target library');
  await fs.writeFile(path.join(sdk, 'sw/info/product.xml'), 'product metadata');
  await fs.writeFile(path.join(sdk, 'sw/info/license.lic'), 'private license fixture');
  const options = {
    root: tools,
    dataRoot: path.join(root, 'data'),
    config: () => getBoardAdapter('STM32F103C8T6').createConfig(),
    env: { PATH: '', Path: '' },
    runner: async (file: string, args: string[], opts?: any) => {
      if (path.basename(file).toLowerCase() === 'armcc' + suffix) {
        assert.deepEqual(args, ['--vsn']);
        return { code: 0, output: versionText };
      }
      return runCommand(file, args, opts);
    },
  };
  const state = await new ToolVersions(options).toolVersionsState();
  const tool = state.localTools?.find((tool) => tool.kind === 'armcc');
  assert.ok(tool?.exportable);
  assert.equal(tool.version, '5.06-u5-b528');
  const exported = new OfflineTools(options);
  const artifact = await exported.exportInstalled({ id: tool.id, confirm: true });
  const receiverRoot = path.join(root, 'receiver');
  const receiver = new OfflineTools({
    ...options,
    root: receiverRoot,
    dataRoot: path.join(root, 'receiver-data'),
  });
  await receiver.install({ path: exported.downloadFile(artifact.id).path, confirm: true });
  for (const file of [
    'bin/armcc' + suffix,
    'bin/armcompiler_libFNP.dll',
    'include/stdint.h',
    'lib/runtime.a',
    'sw/info/product.xml',
  ])
    assert.equal(
      await fs.readFile(path.join(receiverRoot, 'versions/armcc/5.06-u5-b528', file), 'utf8'),
      await fs.readFile(path.join(sdk, file), 'utf8'),
    );
  assert.equal(
    await fs
      .stat(path.join(receiverRoot, 'versions/armcc/5.06-u5-b528/sw/info/license.lic'))
      .catch(() => null),
    null,
  );
});

const realCompiler = process.env.BLODE_ARMCC_TEST_ROOT;
const managedRoot = process.env.BLODE_ARMCC_MANAGED_ROOT;
test(
  'real AC5 compiles through Blode with generated startup, C++ and legacy ARM assembly; exports firmware',
  { skip: !realCompiler || process.platform !== 'win32', timeout: 90000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode real armcc '));
    let core: Awaited<ReturnType<typeof createCore>> | undefined;
    t.after(async () => {
      await core?.shutdown();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const project = path.join(root, '工程 with spaces');
    await fs.mkdir(project);
    const config = getBoardAdapter('STM32F103C8T6').createConfig();
    const build = {
      entry: '.',
      cStandard: 'c99',
      settings: {
        mode: 'debug',
        common: { family: 'armcc', directory: realCompiler, version: '5.06-u5-b528' },
      },
    };
    await fs.writeFile(path.join(project, 'be'), JSON.stringify({ ...config, build }));
    await fs.writeFile(
      path.join(project, 'main.c'),
      '#include <stdint.h>\nextern uint32_t transform(uint32_t);\nextern uint32_t control(void);\nvolatile uint32_t result;\nint main(void){result=transform(control());for(;;){result++;}}\n',
    );
    await fs.writeFile(
      path.join(project, 'helper.cpp'),
      'template<unsigned K> struct Scale{static unsigned run(unsigned value){return value*K;}};\nextern "C" unsigned transform(unsigned value){return Scale<3>::run(value)+1;}\n',
    );
    const legacy = '__asm unsigned control(void) { MRS r0, CONTROL\n BX lr\n }\n';
    await fs.writeFile(path.join(project, 'core_cm3.c'), legacy);
    core = await createCore({
      projectRoot: project,
      dataRoot: path.join(root, 'data'),
      toolchainRoot: path.join(root, 'tools'),
      refreshDevices: false,
      onEvent() {},
    });
    const result = await core.build();
    assert.equal(result.success, true);
    assert.ok(result.flashUsed > 0);
    assert.equal(await fs.readFile(path.join(project, 'core_cm3.c'), 'utf8'), legacy);
    const db = JSON.parse(
      await fs.readFile(path.join(project, '.blode/build/compile_commands.json'), 'utf8'),
    );
    assert.ok(db.some((entry: any) => entry.arguments.includes('-std=gnu99')));
    assert.ok(db.some((entry: any) => entry.arguments.includes('-std=gnu++03')));
    const state = await core.getState();
    for (const format of ['bin', 'hex', 'elf'] as const) {
      const exported = await prepareBuildExport(project, state, format);
      assert.ok(exported.data.length > 0);
    }
    const releaseBuild = { ...build, settings: { ...build.settings, mode: 'release' } };
    await core.saveFile('be', JSON.stringify({ ...config, build: releaseBuild }));
    assert.equal((await core.build()).success, true);
    await fs.writeFile(
      path.join(project, 'startup.s'),
      ' AREA RESET, DATA, READONLY\n EXPORT __Vectors\n__Vectors DCD 0x20005000\n DCD Reset_Handler\n AREA |.text|, CODE, READONLY\n THUMB\n EXPORT Reset_Handler\n IMPORT __main\nReset_Handler PROC\n B __main\n ENDP\n END\n',
    );
    await fs.writeFile(
      path.join(project, 'Project.uvprojx'),
      '<Project><Targets><Target><TargetName>AC5</TargetName><Device>STM32F103C8T6</Device><Groups><Group><Files>' +
        ['main.c', 'helper.cpp', 'core_cm3.c', 'startup.s']
          .map((file) => `<File><FilePath>${file}</FilePath></File>`)
          .join('') +
        '</Files></Group></Groups></Target></Targets></Project>',
    );
    assert.equal((await core.build()).success, true);
    assert.equal(await fs.lstat(path.join(project, '.blode/build/startup_f1_md.s')).catch(() => null), null);
    await core.saveFile('be', JSON.stringify({ ...config, build: { ...build, cStandard: 'c17' } }));
    await assert.rejects(core.build(), /armccStandard/);
    await core.saveFile(
      'be',
      JSON.stringify({
        ...config,
        build: { ...build, settings: { common: { ...build.settings.common, version: '5.06-u5-b999' } } },
      }),
    );
    await assert.rejects(core.build(), /buildCompilerVersion/);
    if (managedRoot) {
      await core.shutdown();
      await fs.writeFile(
        path.join(project, 'be'),
        JSON.stringify({
          ...config,
          build: { ...build, settings: { common: { family: 'armcc', version: '5.06-u5-b528' } } },
        }),
      );
      core = await createCore({
        projectRoot: project,
        dataRoot: path.join(root, 'managed-data'),
        toolchainRoot: managedRoot,
        refreshDevices: false,
        onEvent() {},
      });
      assert.equal((await core.build()).success, true);
      const tools = await new ToolVersions({
        root: managedRoot,
        dataRoot: path.join(root, 'managed-data'),
        config: () => config,
        runner: runCommand,
        env: { PATH: '', Path: '' },
      }).toolVersionsState();
      assert.ok(
        tools.installedTools?.some(
          (tool) => tool.family === 'armcc' && tool.version === '5.06-u5-b528' && tool.source === 'versioned',
        ),
      );
      await core.saveFile(
        'be',
        JSON.stringify({
          ...config,
          build: {
            ...build,
            settings: { common: { family: 'armcc', version: '5.06-u5-b528' } },
            targets: [{ id: 'ac5', name: 'AC5 target', root: '.' }],
          },
        }),
      );
      const target = await core.build('ac5');
      assert.equal(target.success, true);
      assert.ok(target.artifacts[0].startsWith('.blode/targets/ac5/'));
    }
  },
);
