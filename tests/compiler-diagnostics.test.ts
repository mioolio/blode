import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { CompilerOutput, parseCompilerDiagnostic } from '../src/core/compiler-diagnostics';
import { createCore } from '../src/core/service';
import { getBoardAdapter } from '../extensions/registry';
import type { LogEvent } from '../src/shared/contracts';
import type { CreatePlatformRuntimes, RuntimeHost } from '../extensions/runtime';
import {
  setCompilerProblems,
  setEditorProblems,
  editorProblemsSnapshot,
} from '../src/renderer/workspace/editorProblems';
import { attachCompilerDiagnostics } from '../src/renderer/editor/compilerDiagnostics';

test('GCC, Clang, Arm Compiler 5/6 and linker warnings retain source positions and severity', () => {
  for (const [input, expected] of [
    [
      'C:\\项目\\User\\main.c:64:17: warning: format mismatch [-Wformat=]',
      ['C:\\项目\\User\\main.c', 64, 17, 'warning'],
    ],
    ['src/main.c:9:2: fatal error: device.h: No such file', ['src/main.c', 9, 2, 'error']],
    [
      '"User/main.c", line 12: Warning: #550-D: variable was set but never used',
      ['User/main.c', 12, 1, 'warning'],
    ],
    ['User/main.c(7, 5): warning C4996: deprecated', ['User/main.c', 7, 5, 'warning']],
    ['User/main.c:1: warning: unused', ['User/main.c', 1, 1, 'warning']],
  ] as const) {
    const item = parseCompilerDiagnostic(input)!;
    assert.deepEqual([item.file, item.line, item.column, item.severity], expected);
  }
  assert.equal(
    parseCompilerDiagnostic('c:/tools/bin/ld.exe: lib.a(.text): warning: _kill_r is not implemented')
      ?.severity,
    'warning',
  );
  assert.equal(
    parseCompilerDiagnostic('\x1b[33mwarning: unused argument\x1b[0m')?.message,
    'unused argument',
  );
  for (const input of [
    '64 | printf("warning: demo");',
    'note: declared here',
    'Compilation completed',
    'C:\\path\\main.c: In function f:',
  ])
    assert.equal(parseCompilerDiagnostic(input), undefined);
});

test('Arduino staged sketches, nested source folders, components and named targets map to exact original files', () => {
  const workspace = path.resolve('compiler-fixture'),
    sourceRoot = path.join(workspace, 'camera');
  const output = new CompilerOutput({
    projectRoot: workspace,
    sourceRoot,
    files: [
      { path: 'src/SerialCamera.ino' },
      { path: 'src/camera.h' },
      { path: 'other/camera.h' },
      { path: 'components/led/led.c' },
    ],
    build: {
      entry: 'src/SerialCamera.ino',
      components: {
        roots: ['components/led'],
        sources: ['components/led/led.c'],
        includeDirectories: [],
        arduinoLibraries: [],
        inputs: ['components/led/led.c'],
      },
    },
    namespace: '.blode/targets/cam',
  });
  const staging = path.join(sourceRoot, '.blode/targets/cam/staging/camera');
  for (const [input, expected] of [
    [path.join(staging, 'camera.ino'), 'camera/src/SerialCamera.ino'],
    [path.join(staging, 'camera.h'), 'camera/src/camera.h'],
    [path.join(staging, 'src/blode_components/components/led/led.c'), 'camera/components/led/led.c'],
    [path.join(sourceRoot, 'other/camera.h'), 'camera/other/camera.h'],
  ]) {
    assert.equal(output.parse(`${input}:22:8: warning: fixture`)?.location?.path, expected);
  }
  assert.equal(output.parse('camera.h:22:8: warning: unknown duplicate basename')?.location, undefined);
  assert.equal(
    output.parse(`${path.join(workspace, '..', 'private.c')}:22:8: warning: outside`)?.location,
    undefined,
  );
});

test('build warnings from a runtime are classified for desktop/Web with their original sketch, then context is released', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-build-diagnostic-'));
  const workspace = path.join(directory, 'project');
  await fs.mkdir(workspace);
  const config = getBoardAdapter('Esp32_S3_CAM').createConfig();
  await fs.writeFile(path.join(workspace, 'SerialCamera.ino'), 'void setup() {}\nvoid loop() {}\n');
  await fs.writeFile(
    path.join(workspace, 'be'),
    JSON.stringify({ ...config, build: { entry: 'SerialCamera.ino' } }),
  );
  const events: LogEvent[] = [];
  let runtimeHost: RuntimeHost;
  const createRuntimes: CreatePlatformRuntimes = (host) => {
    runtimeHost = host;
    return [
      {
        id: config.boardId,
        transport: 'serial',
        sourceInputs: [],
        status: async () => ({
          arduinoCli: true,
          esp32Core: true,
          python: true,
          esptool: true,
          versions: {},
        }),
        install: async () => {
          throw Error('not used');
        },
        discover: async () => [],
        probe: async () => ({ output: '', config }),
        invalidate() {},
        flash: async () => {},
        build: async () => {
          const stage = await host.resetDirectory(`.blode/staging/${path.basename(host.projectRoot())}`);
          host.emit(
            `${path.join(stage, `${path.basename(host.projectRoot())}.ino`)}:2:6: warning: sample compiler warning`,
          );
          const output = await host.resetDirectory('.blode/build');
          await fs.writeFile(path.join(output, 'fixture.bin'), 'fixture');
          return {
            success: true,
            flashUsed: 0,
            ramUsed: 0,
            flashTotal: config.flashSize,
            ramTotal: 1024,
            artifacts: ['.blode/build/fixture.bin'],
            timestamp: new Date().toISOString(),
            output: '',
          };
        },
      },
    ];
  };
  const core = await createCore({
    projectRoot: workspace,
    dataRoot: path.join(directory, 'data'),
    refreshDevices: false,
    createRuntimes,
    onEvent: (e) => events.push(e),
  });
  t.after(async () => {
    await core.shutdown();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.equal((await core.build()).success, true);
  const warning = events.find((e) => e.diagnostic)!;
  assert.equal(warning.level, 'warning');
  assert.equal(warning.diagnostic?.location?.path, 'SerialCamera.ino');
  assert.equal(warning.diagnostic?.location?.line, 2);
  runtimeHost!.emit('SerialCamera.ino:2:6: warning: not a build');
  assert.equal(events.at(-1)?.diagnostic, undefined);
});

test('build diagnostics count unopened files, deduplicate editor findings and paint models opened later', (t) => {
  setEditorProblems([]);
  setCompilerProblems('', []);
  const disposables: { dispose(): void }[] = [];
  t.after(() => {
    disposables.forEach((item) => item.dispose());
    setCompilerProblems('', []);
    setEditorProblems([]);
  });
  const diagnostic = {
    projectRoot: '/workspace',
    severity: 'warning' as const,
    message: 'unused variable',
    location: { path: 'src/main.c', line: 2, column: 7, endLine: 2, endColumn: 8 },
  };
  const log = {
    kind: 'log' as const,
    level: 'warning' as const,
    message: 'compiler line',
    time: 'now',
    diagnostic,
  };
  setCompilerProblems('/workspace', [log, log]);
  assert.equal(editorProblemsSnapshot().length, 1);
  setEditorProblems([
    { ...diagnostic.location, severity: 'warning', message: diagnostic.message, source: 'clang' },
  ]);
  assert.equal(editorProblemsSnapshot().length, 1);
  let createModel = () => {};
  const markers: any[] = [],
    decorations: any[] = [],
    models: any[] = [];
  const monaco: any = {
    MarkerSeverity: { Warning: 4, Error: 8 },
    Range: class {
      constructor(...publicArgs: any[]) {
        Object.assign(this, { values: publicArgs });
      }
    },
    editor: {
      OverviewRulerLane: { Right: 4 },
      getModels: () => models,
      setModelMarkers: (_model: any, owner: string, items: any[]) => markers.push({ owner, items }),
      onDidCreateModel: (callback: () => void) => {
        createModel = callback;
        return { dispose() {} };
      },
    },
  };
  attachCompilerDiagnostics(monaco, { root: () => '/workspace', path: () => 'src/main.c' }, disposables);
  models.push({
    uri: { path: '/workspace/src/main.c' },
    isDisposed: () => false,
    getLineCount: () => 3,
    getLineMaxColumn: () => 40,
    deltaDecorations: (_old: any[], next: any[]) => {
      decorations.push(next);
      return next.map((_, i) => String(i));
    },
  });
  createModel();
  assert.equal(markers.at(-1).owner, 'blode-compiler');
  assert.equal(markers.at(-1).items[0].startLineNumber, 2);
  assert.equal(decorations.at(-1)[0].options.className, 'compiler-warning-line');
  setCompilerProblems('/workspace', []);
  assert.equal(markers.at(-1).items.length, 0);
  setCompilerProblems('/other', [log]);
  assert.equal(editorProblemsSnapshot().length, 0);
});
