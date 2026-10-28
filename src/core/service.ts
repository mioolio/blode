import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppState, BuildResult, CoreApi, LogEvent, ProjectConfig } from '../shared/contracts';
import { getBoardAdapter, listBoards } from '../../extensions/registry';
import { buildFlashArgs, buildProbeArgs } from '../../extensions/programmers/esptool';
import { parseConfig, type ProjectBuild } from './config';
import {
  loadProjectDescriptor,
  persistConfig,
  readProjectFiles,
  safeWorkspacePath,
  writeProjectFile,
  scanProjectInventory,
  watchWorkspace,
  createProjectFile,
  createProjectDirectory,
  renameProjectEntry,
  deleteProjectEntry,
  ensureProjectMarker,
} from './workspace';
import { loadBuildState, saveBuildState, hashArtifacts, artifactsMatch } from './build-state';
import { toPartitionCsv } from './partitions';
import { runCommand } from './process';
import { Toolchains } from './toolchain';
import { SerialConnection } from './serial';

export interface CoreOptions {
  /** Empty when the application starts without a workspace. */
  projectRoot: string;
  dataRoot: string;
  onEvent: (event: LogEvent) => void;
  fetcher?: typeof fetch;
  toolchainEnv?: NodeJS.ProcessEnv;
  /** Optional portable toolchain root; defaults to `<dataRoot>/toolchains`. */
  toolchainRoot?: string;
}
export interface CoreService extends CoreApi {
  shutdown(): Promise<void>;
  setProjectRoot(root: string): Promise<void>;
}

/** Hardware and filesystem services have one owner, independent of any window. */
export async function createCore(options: CoreOptions): Promise<CoreService> {
  let projectRoot = '';
  let config = getBoardAdapter('esp32-s3').createConfig();
  let projectBuild: ProjectBuild = {};
  if (options.projectRoot) {
    await fs.mkdir(options.projectRoot, { recursive: true });
    projectRoot = await fs.realpath(options.projectRoot);
    const loaded = await loadProjectDescriptor(projectRoot, config);
    config = loaded.config;
    projectBuild = loaded.build;
    getBoardAdapter(config.boardId).validateConfig(config);
  }
  const requireWorkspace = (): string => {
    if (!projectRoot) throw new Error('error.noWorkspace');
    return projectRoot;
  };
  let lastBuild: BuildResult | null = null;
  let builtFingerprint = '';
  let artifactHashes: Record<string, string> = {};
  let busy = false;
  const lifecycle = new AbortController();
  const emit = (message: string, level: LogEvent['level'] = 'info', kind: LogEvent['kind'] = 'log') =>
    options.onEvent({ kind, level, message, time: new Date().toISOString() });
  const toolchains = new Toolchains(
    options.dataRoot,
    (line) => emit(line),
    {
      fetcher: options.fetcher,
      env: options.toolchainEnv,
      signal: lifecycle.signal,
    },
    options.toolchainRoot,
  );
  const serial = new SerialConnection(
    (data) => emit(data, 'info', 'serial'),
    (error) => emit(error.message, 'error', 'serial'),
  );
  const closeSerial = async () => {
    const wasOpen = serial.isOpen;
    await serial.close();
    if (wasOpen) emit('status.serialDisconnected', 'info', 'status');
  };

  const withLock = async <T>(action: () => Promise<T>): Promise<T> => {
    if (lifecycle.signal.aborted) throw new Error('error.operationCancelled');
    if (busy) throw new Error('error.busy');
    busy = true;
    try {
      return await action();
    } catch (error) {
      emit(error instanceof Error ? error.message : String(error), 'error');
      throw error;
    } finally {
      busy = false;
    }
  };
  const requirePort = async (requested = config.port): Promise<string> => {
    if (!requested) throw new Error('error.selectPort');
    const ports = await SerialConnection.list();
    if (!ports.some((port) => port.path === requested)) throw new Error('error.portUnavailable');
    return requested;
  };
  const fingerprint = async (
    source = undefined as Awaited<ReturnType<typeof readProjectFiles>> | undefined,
  ) => {
    source ??= await readProjectFiles(projectRoot);
    // Ignore port/speed only: changing a physical port must not invalidate firmware.
    return createHash('sha256')
      .update(JSON.stringify({ ...config, port: '', baudRate: 0 }))
      .update(JSON.stringify(source))
      .digest('hex');
  };
  const currentFingerprint = async (source?: Awaited<ReturnType<typeof readProjectFiles>>) => {
    let value = await fingerprint(source);
    if (config.boardId === 'generic')
      value = createHash('sha256')
        .update(value)
        .update(await fs.readFile(await safeWorkspacePath(projectRoot, 'firmware.bin')))
        .digest('hex');
    return value;
  };
  const persistSuccessfulBuild = async () => {
    if (lastBuild?.success && builtFingerprint)
      await saveBuildState(projectRoot, {
        version: 1,
        result: lastBuild,
        sourceFingerprint: builtFingerprint,
        artifactHashes,
      });
  };
  const restoreSuccessfulBuild = async () => {
    const saved = await loadBuildState(projectRoot);
    lastBuild = saved?.result ?? null;
    builtFingerprint = saved?.sourceFingerprint ?? '';
    artifactHashes = saved?.artifactHashes ?? {};
  };
  const isBuildStale = async (files?: Awaited<ReturnType<typeof readProjectFiles>>) => {
    if (!lastBuild) return false;
    try {
      return (
        builtFingerprint !== (await currentFingerprint(files)) ||
        !(await artifactsMatch(projectRoot, artifactHashes))
      );
    } catch {
      return true;
    }
  };
  let stopWatching: () => void = () => {};
  if (projectRoot) {
    stopWatching = watchWorkspace(
      projectRoot,
      () => emit('status.workspaceChanged', 'info', 'status'),
      (error) => emit(error.message, 'warning'),
    );
    await restoreSuccessfulBuild();
  }
  const probeDevice = async (port: string): Promise<string> => {
    await closeSerial();
    const python = await toolchains.pythonPath(config);
    const result = await runCommand(python, buildProbeArgs(port), {
      timeout: 45_000,
      onLine: (line) => emit(line),
      signal: lifecycle.signal,
    });
    if (result.code !== 0) throw new Error(result.output || 'error.probeFailed');
    return result.output;
  };
  const assertProbeCompatible = (output: string) => {
    if (config.boardId === 'esp32-s3' && !/ESP32-S3/i.test(output)) throw new Error('error.chipMismatch');
    const flashMatch = output.match(/(?:Detected flash size|Flash size)\s*:\s*(\d+)\s*MB/i);
    if (flashMatch && config.flashSize > Number(flashMatch[1]) * 1_048_576)
      throw new Error('error.deviceFlashTooSmall');
  };
  const buildPath = async () => safeWorkspacePath(projectRoot, '.blode/build', { internal: true });

  const api: CoreService = {
    async getState(): Promise<AppState> {
      const [ports, toolchain] = await Promise.all([SerialConnection.list(), toolchains.status(config)]);
      if (!projectRoot)
        return {
          projectRoot: '',
          workspaceOpen: false,
          config: structuredClone(config),
          files: [],
          inventory: { entries: [], totalBytes: 0, fileCount: 0, directoryCount: 0, truncated: false },
          boards: listBoards(),
          ports,
          toolchain,
          lastBuild: null,
          buildStale: false,
          pipe: { endpoint: '', tokenFile: '' },
          web: { endpoint: '', tokenFile: '', allowExternal: false },
        };
      const files = await readProjectFiles(projectRoot);
      const [inventory, buildStale] = await Promise.all([
        scanProjectInventory(projectRoot, new Set(files.map((file) => file.path))),
        isBuildStale(files),
      ]);
      return {
        projectRoot,
        workspaceOpen: true,
        config: structuredClone(config),
        files,
        inventory,
        boards: listBoards(),
        ports,
        toolchain,
        lastBuild: lastBuild ? structuredClone(lastBuild) : null,
        buildStale,
        pipe: { endpoint: '', tokenFile: '' },
        web: { endpoint: '', tokenFile: '', allowExternal: false },
      };
    },
    async listPorts() {
      return SerialConnection.list();
    },
    async saveFile(relative, content) {
      return withLock(async () => {
        await writeProjectFile(requireWorkspace(), relative, content);
        emit('status.fileSaved', 'success');
      });
    },
    async createFile(relative) {
      return withLock(async () => {
        await createProjectFile(requireWorkspace(), relative);
        emit('status.workspaceChanged', 'success', 'status');
      });
    },
    async createDirectory(relative) {
      return withLock(async () => {
        await createProjectDirectory(requireWorkspace(), relative);
        emit('status.workspaceChanged', 'success', 'status');
      });
    },
    async renameEntry(from, to) {
      return withLock(async () => {
        await renameProjectEntry(requireWorkspace(), from, to);
        emit('status.workspaceChanged', 'success', 'status');
      });
    },
    async deleteEntry(relative) {
      return withLock(async () => {
        await deleteProjectEntry(requireWorkspace(), relative);
        emit('status.workspaceChanged', 'success', 'status');
      });
    },
    async saveConfig(value) {
      return withLock(async () => {
        const parsed = parseConfig(value);
        getBoardAdapter(parsed.boardId).validateConfig(parsed);
        await persistConfig(requireWorkspace(), parsed);
        config = parsed;
        toolchains.invalidate();
        emit('status.configSaved', 'success');
      });
    },
    async build() {
      return withLock(async () => {
        requireWorkspace();
        const adapter = getBoardAdapter(config.boardId);
        adapter.validateConfig(config);
        emit('status.buildStarted', 'info', 'status');
        if (config.boardId === 'generic') {
          // A generic adapter writes an already-built merged image; it does not invent a compiler.
          const binary = await safeWorkspacePath(projectRoot, 'firmware.bin');
          const stat = await fs.stat(binary).catch(() => {
            throw new Error('error.noFirmware');
          });
          const app = config.partitions.find((p) => p.type === 'app')!;
          if (stat.size <= 0 || stat.size > app.size) throw new Error('error.firmwareTooLarge');
          builtFingerprint = await currentFingerprint();
          artifactHashes = await hashArtifacts(projectRoot, ['firmware.bin']);
          lastBuild = {
            success: true,
            flashUsed: stat.size,
            ramUsed: 0,
            flashTotal: app.size,
            ramTotal: adapter.definition.ramSize,
            artifacts: ['firmware.bin'],
            timestamp: new Date().toISOString(),
            output: 'status.firmwareValidated',
          };
          await persistSuccessfulBuild();
          emit('status.firmwareValidated', 'success');
          return structuredClone(lastBuild);
        }
        const status = await toolchains.status(config, true);
        if (!status.arduinoCli || !status.esp32Core) throw new Error('error.toolchainMissing');
        const allFiles = await readProjectFiles(projectRoot);
        let files = allFiles;
        if (projectBuild.files?.length) {
          const byPath = new Map(allFiles.map((file) => [file.path, file]));
          files = projectBuild.files.map((declared) => {
            const file = byPath.get(declared.replaceAll('\\', '/'));
            if (!file) throw new Error('error.projectFileMissing');
            return file;
          });
        }
        const declaredSketch = projectBuild.sketch?.replaceAll('\\', '/');
        let main = declaredSketch ? files.find((file) => file.path === declaredSketch) : undefined;
        if (declaredSketch && !main) throw new Error('error.projectFileMissing');
        main ??=
          files.find((file) => file.path.endsWith('.ino') && !file.path.includes('/')) ??
          files.find((file) => file.path.endsWith('.ino'));
        if (!main) throw new Error('error.noSketch');
        const sketchName = path.basename(projectRoot).replace(/[^a-zA-Z0-9_]/g, '_') || 'sketch';
        const stage = await safeWorkspacePath(projectRoot, `.blode/staging/${sketchName}`, {
          internal: true,
        });
        // Internal directories are checked before deletion; never delete a computed external target.
        const relativeStage = path.relative(projectRoot, stage);
        if (!relativeStage.startsWith(`.blode${path.sep}staging${path.sep}`))
          throw new Error('error.invalidPath');
        await fs.rm(stage, { recursive: true, force: true });
        await fs.mkdir(stage, { recursive: true });
        for (const file of files) {
          const destination = path.join(stage, file === main ? `${sketchName}.ino` : file.path);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, file.content, 'utf8');
        }
        await fs.writeFile(path.join(stage, 'partitions.csv'), toPartitionCsv(config.partitions));
        const outputDirectory = await buildPath();
        const relativeBuild = path.relative(projectRoot, outputDirectory);
        if (relativeBuild !== `.blode${path.sep}build`) throw new Error('error.invalidPath');
        await fs.rm(outputDirectory, { recursive: true, force: true });
        await fs.mkdir(outputDirectory, { recursive: true });
        const before = await fingerprint();
        const result = await toolchains.runCli(
          config,
          [
            'compile',
            '--fqbn',
            adapter.getFqbn(config),
            '--build-path',
            outputDirectory,
            '--warnings',
            'all',
            '--build-property',
            `upload.maximum_size=${config.partitions.find((p) => p.type === 'app')!.size}`,
            stage,
          ],
          900_000,
        );
        // Arduino's merged image assumes fixed addresses; advertise only authoritative segments.
        const expectedBinaries = [
          `${sketchName}.ino.bin`,
          `${sketchName}.ino.bootloader.bin`,
          `${sketchName}.ino.partitions.bin`,
        ];
        const binaries = (await fs.readdir(outputDirectory)).filter((file) =>
          expectedBinaries.includes(file),
        );
        const sketchBinary = binaries.find((file) => file === `${sketchName}.ino.bin`);
        const binarySize = sketchBinary ? (await fs.stat(path.join(outputDirectory, sketchBinary))).size : 0;
        const buildResult = parseBuildOutput(result.output, {
          success: result.code === 0 && expectedBinaries.every((file) => binaries.includes(file)),
          flashTotal: config.partitions.find((p) => p.type === 'app')!.size,
          ramTotal: adapter.definition.ramSize,
          binarySize,
          artifacts: binaries.map((file) => `.blode/build/${file}`),
        });
        if (buildResult.success && before === (await fingerprint())) {
          lastBuild = buildResult;
          builtFingerprint = before;
          artifactHashes = await hashArtifacts(projectRoot, lastBuild.artifacts);
          await persistSuccessfulBuild();
        } else if (buildResult.success) {
          buildResult.success = false;
          emit('error.sourceChanged', 'error');
        }
        emit(
          buildResult.success ? 'status.buildSucceeded' : 'status.buildFailed',
          buildResult.success ? 'success' : 'error',
          'status',
        );
        return structuredClone(buildResult);
      });
    },
    async flash() {
      return withLock(async () => {
        requireWorkspace();
        if (!lastBuild?.success || !builtFingerprint || builtFingerprint !== (await currentFingerprint()))
          throw new Error('error.buildRequired');
        if (!(await artifactsMatch(projectRoot, artifactHashes))) throw new Error('error.artifactChanged');
        const port = await requirePort();
        const probe = await probeDevice(port);
        assertProbeCompatible(probe);
        emit('status.flashStarted', 'info', 'status');
        if (config.boardId === 'generic') {
          const binary = await safeWorkspacePath(projectRoot, 'firmware.bin');
          const app = config.partitions.find((p) => p.type === 'app')!;
          const result = await runCommand(
            await toolchains.pythonPath(config),
            buildFlashArgs(
              port,
              config.baudRate,
              [{ path: binary, offset: app.offset, size: (await fs.stat(binary)).size }],
              'auto',
              config.flashSize,
            ),
            { timeout: 180_000, onLine: (line) => emit(line), signal: lifecycle.signal },
          );
          if (result.code !== 0) throw new Error(result.output || 'error.flashFailed');
        } else {
          const bootloaderFile = lastBuild.artifacts.find((file) => file.endsWith('.bootloader.bin'));
          const partitionFile = lastBuild.artifacts.find((file) => file.endsWith('.partitions.bin'));
          const applicationFile = lastBuild.artifacts.find((file) => file.endsWith('.ino.bin'));
          if (!bootloaderFile || !partitionFile || !applicationFile) throw new Error('error.noFirmware');
          // Arduino's default upload recipe fixes the app at 0x10000. Explicit segments
          // make the visual map authoritative and avoid writing OTA metadata over NVS.
          const segments = await Promise.all(
            [
              { file: bootloaderFile, offset: 0 },
              { file: partitionFile, offset: 0x8000 },
              { file: applicationFile, offset: config.partitions.find((p) => p.type === 'app')!.offset },
            ].map(async (segment) => {
              const fullPath = await safeWorkspacePath(projectRoot, segment.file, { internal: true });
              return { path: fullPath, offset: segment.offset, size: (await fs.stat(fullPath)).size };
            }),
          );
          const result = await runCommand(
            await toolchains.pythonPath(config),
            buildFlashArgs(port, config.baudRate, segments, 'esp32s3', config.flashSize),
            { timeout: 180_000, onLine: (line) => emit(line), signal: lifecycle.signal },
          );
          if (result.code !== 0) throw new Error(result.output || 'error.flashFailed');
        }
        emit('status.flashSucceeded', 'success', 'status');
      });
    },
    async probe(port) {
      return withLock(async () => probeDevice(await requirePort(port)));
    },
    async installToolchain() {
      return withLock(async () => toolchains.install(config));
    },
    async serialOpen(port, baudRate = 115200) {
      return withLock(async () => {
        if (!Number.isInteger(baudRate) || baudRate < 1200 || baudRate > 3_000_000)
          throw new Error('error.invalidBaudRate');
        await serial.open(await requirePort(port), baudRate);
        emit('status.serialConnected', 'success', 'status');
      });
    },
    async serialClose() {
      return withLock(async () => closeSerial());
    },
    async serialWrite(data) {
      return withLock(async () => serial.write(data));
    },
    async setProjectRoot(root) {
      return withLock(async () => {
        const resolved = await fs.realpath(root);
        // Reading/creating `be` is the explicit project-area association step.
        await ensureProjectMarker(resolved);
        const loaded = await loadProjectDescriptor(
          resolved,
          getBoardAdapter('esp32-s3').createConfig(),
        );
        const nextConfig = loaded.config;
        getBoardAdapter(nextConfig.boardId).validateConfig(nextConfig);
        await closeSerial();
        stopWatching();
        projectRoot = resolved;
        config = nextConfig;
        projectBuild = loaded.build;
        lastBuild = null;
        builtFingerprint = '';
        artifactHashes = {};
        toolchains.invalidate();
        await restoreSuccessfulBuild();
        stopWatching = watchWorkspace(
          projectRoot,
          () => emit('status.workspaceChanged', 'info', 'status'),
          (error) => emit(error.message, 'warning'),
        );
        emit('status.projectOpened', 'success');
      });
    },
    async shutdown() {
      lifecycle.abort();
      stopWatching();
      await serial.close();
    },
  };
  return api;
}

export function parseBuildOutput(
  output: string,
  defaults: {
    success: boolean;
    flashTotal: number;
    ramTotal: number;
    binarySize: number;
    artifacts: string[];
  },
): BuildResult {
  const flash = output.match(/Sketch uses\s+([\d,]+)\s+bytes/i);
  const ram = output.match(/Global variables use\s+([\d,]+)\s+bytes/i);
  const ramMaximum = output.match(/Global variables use[^\r\n]*Maximum is\s+([\d,]+)\s+bytes/i);
  const number = (value: string | undefined) => Number(value?.replaceAll(',', '') ?? 0);
  return {
    success: defaults.success,
    flashUsed: flash ? number(flash[1]) : defaults.binarySize,
    ramUsed: number(ram?.[1]),
    flashTotal: defaults.flashTotal,
    ramTotal: ramMaximum ? number(ramMaximum[1]) : defaults.ramTotal,
    artifacts: defaults.artifacts,
    timestamp: new Date().toISOString(),
    output,
  };
}
