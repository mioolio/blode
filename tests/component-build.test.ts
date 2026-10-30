import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComponentLibraries } from '../src/core/components';
import { withComponentBuildInputs } from '../src/core/component-build';
import { getBoardAdapter } from '../extensions/registry';
import { readProjectFiles, safeWorkspacePath } from '../src/core/workspace';
import { createEsp32S3Runtime } from '../extensions/boards/Esp32_S3_CAM/runtime/index';
import { Toolchains } from '../extensions/boards/Esp32_S3_CAM/tools/toolchain';
import { Stm32Compiler } from '../extensions/boards/STM32F103C8T6/compiler/index';
import { createCore } from '../src/core/service';
import type { RuntimeHost } from '../extensions/runtime';
import type { ProjectBuildInputs, ProjectConfig } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-component-build-'));
  const project = path.join(root, 'project'),
    source = path.join(root, 'LocalC'),
    arduino = path.join(root, 'ArduinoFixture');
  for (const dir of [project, source, arduino]) await fs.mkdir(dir);
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('blode-component-build-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const put = async (dir: string, file: string, text: string) => {
    const full = path.join(dir, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text);
  };
  await put(source, 'src/answer.c', 'int answer(void){return 42;}');
  await put(source, 'include/answer.h', 'int answer(void);');
  await put(source, 'examples/ignored.c', 'int main(){return 1;}');
  await put(source, '.github/workflow.yml', 'test');
  await put(source, 'binary.a', 'binary-fixture');
  await put(arduino, 'library.properties', 'name=ArduinoFixture\nversion=1.0.0\narchitectures=*');
  await put(arduino, 'src/Fixture.h', 'int fixture();');
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  const libraries = new ComponentLibraries({
    projectRoot: () => project,
    dataRoot: path.join(root, 'data'),
    toolchainRoot: path.join(root, 'tools'),
    config: () => config,
  });
  const host: RuntimeHost = {
    dataRoot: root,
    signal: new AbortController().signal,
    emit() {},
    projectRoot: () => project,
    readProjectFiles: () => readProjectFiles(project),
    resolveWorkspacePath: (file, options) => safeWorkspacePath(project, file, options),
    async resetDirectory(relative) {
      const dir = await safeWorkspacePath(project, relative, { internal: true });
      assert.ok(dir.startsWith(project + path.sep));
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    listPorts: async () => [],
    closeSerial: async () => {},
    requirePort: async () => {
      throw Error('No hardware');
    },
    runCommand: async () => {
      throw Error('No external compiler');
    },
  };
  return { root, project, source, arduino, put, config, libraries, host };
}

test('imported components are included despite an explicit entry and file list, with Arduino library discovery preserved', async (t) => {
  const f = await fixture(t);
  await f.put(f.project, 'app/main.ino', '#include <Fixture.h>\nvoid setup(){} void loop(){}');
  await f.libraries.importDirectory(f.source, f.project);
  await f.libraries.importDirectory(f.arduino, f.project);
  const build = await withComponentBuildInputs(f.project, { entry: 'app/main.ino', files: ['app/main.ino'] });
  assert.deepEqual(build.components?.sources, ['components/LocalC/src/answer.c']);
  assert.ok(build.components?.inputs.includes('components/LocalC/binary.a'));
  assert.ok(!build.components?.inputs.some((file) => file.includes('.github')));
  t.mock.method(Toolchains.prototype, 'status', async () => ({
    arduinoCli: true,
    esp32Core: true,
    python: true,
    esptool: true,
    versions: {},
  }));
  t.mock.method(Toolchains.prototype, 'runCli', async (_config: ProjectConfig, args: string[]) => {
    assert.equal(args[args.indexOf('--libraries') + 1], path.join(f.project, 'libraries'));
    if (args.includes('--show-properties=expanded'))
      return {
        code: 0,
        output:
          'compiler.cpp.flags=-Os\nrecipe.cpp.o.pattern=compile\ncompiler.c.extra_flags=-MMD -c\ncompiler.cpp.extra_flags=-MMD -c',
      };
    const stage = args.at(-1)!;
    assert.match(
      await fs.readFile(path.join(stage, 'src/blode_components/components/LocalC/src/answer.c'), 'utf8'),
      /return 42/,
    );
    await assert.rejects(
      fs.access(path.join(stage, 'src/blode_components/components/LocalC/examples/ignored.c')),
    );
    assert.ok(
      args.some(
        (arg) => arg.includes('compiler.c.extra_flags=-MMD -c') && arg.includes('/components/LocalC/include'),
      ),
    );
    assert.ok(args.some((arg) => arg.includes('"-I') && arg.includes('/components/LocalC/include"')));
    assert.ok(!args.some((arg) => arg.includes('-I"')));
    const output = args[args.indexOf('--build-path') + 1];
    for (const suffix of ['.ino.bin', '.ino.bootloader.bin', '.ino.partitions.bin'])
      await fs.writeFile(path.join(output, 'project' + suffix), Buffer.alloc(16));
    return { code: 0, output: 'Sketch uses 16 bytes.' };
  });
  assert.equal((await createEsp32S3Runtime(f.host).build(f.config, build)).success, true);
});

test('STM32 includes managed C components outside its entry scope without compiling their examples', async (t) => {
  const f = await fixture(t);
  await f.put(f.project, 'app/main.c', 'int main(){return 0;}');
  await f.libraries.importDirectory(f.source, f.project);
  const inputs = await withComponentBuildInputs(f.project, { entry: 'app/main.c', files: ['app/main.c'] });
  const compiler = new Stm32Compiler(f.host);
  const files = await compiler.buildInputs(inputs);
  assert.ok(files.includes('components/LocalC/src/answer.c'));
  assert.ok(!files.some((file) => file.includes('/examples/')));
  await f.libraries.importDirectory(f.arduino, f.project);
  await assert.rejects(
    compiler.buildInputs(await withComponentBuildInputs(f.project, inputs)),
    /componentRequiresArduino/,
  );
});

test('component binaries participate in successful-build freshness independently of the text editor cache', async (t) => {
  const f = await fixture(t);
  await f.put(f.project, 'main.ino', 'void setup(){} void loop(){}');
  await f.put(
    f.project,
    'be',
    JSON.stringify({ ...f.config, build: { sketch: 'main.ino', files: ['main.ino'] } }),
  );
  await f.libraries.importDirectory(f.source, f.project);
  let captured: ProjectBuildInputs | undefined;
  const core = await createCore({
    projectRoot: f.project,
    dataRoot: path.join(f.root, 'core-data'),
    refreshDevices: false,
    onEvent() {},
    createRuntimes: (host) => [
      {
        id: 'Esp32_S3_CAM',
        transport: 'serial',
        sourceInputs: [],
        invalidate() {},
        async status() {
          return { arduinoCli: true, esp32Core: true, python: true, esptool: true, versions: {} };
        },
        async install() {
          throw Error('No install');
        },
        async discover() {
          return [];
        },
        async probe() {
          throw Error('No hardware');
        },
        async flash() {
          throw Error('No hardware');
        },
        async build(_config, inputs) {
          captured = inputs;
          const file = await host.resolveWorkspacePath('.blode/build/app.bin', { internal: true });
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, 'output');
          return {
            success: true,
            flashUsed: 6,
            ramUsed: 0,
            flashTotal: 65536,
            ramTotal: 20480,
            artifacts: ['.blode/build/app.bin'],
            timestamp: new Date().toISOString(),
            output: 'ok',
          };
        },
      },
    ],
  });
  try {
    assert.equal((await core.build()).success, true);
    assert.ok(captured?.components?.sources.includes('components/LocalC/src/answer.c'));
    assert.equal((await core.getState()).buildStale, false);
    await f.put(f.project, 'components/LocalC/binary.a', 'changed binary');
    assert.equal((await core.getState()).buildStale, true);
  } finally {
    await core.shutdown();
  }
});
