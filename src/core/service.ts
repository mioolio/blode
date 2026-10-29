import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  AppState,
  BuildResult,
  CoreApi,
  DriverId,
  DriverStatus,
  DebugProbeInfo,
  DetectionScan,
  DetectionCandidate,
  ToolchainStatus,
  LogEvent,
  ProjectConfig,
  PortInfo,
  InstallationProgress,
} from '../shared/contracts';
import type { CreatePlatformRuntimes, RuntimeHost, RuntimeFirmwareImage } from '../../extensions/runtime';
import { createPlatformRuntimes } from '../../extensions/runtime-registry';
import { getBoardAdapter, listBoards } from '../../extensions/registry';
import { parseConfig, parseProjectDescriptor, type ProjectBuild } from './config';
import {
  loadProjectDescriptor,
  persistConfig,
  persistBuildEntry,
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
  PROJECT_MARKER,
} from './workspace';
import { loadBuildState, saveBuildState, hashArtifacts, artifactsMatch } from './build-state';
import { runCommand } from './process';
import { SerialConnection } from './serial';
import { Drivers } from './drivers';
import { InstallationTracker } from './installation';

interface InstallationReporter {
  progress: (progress: InstallationProgress) => void;
  log: (line: string) => void;
  fetcher?: typeof fetch;
  signal: AbortSignal;
}

export interface CoreOptions {
  /** Empty when the application starts without a workspace. */
  projectRoot: string;
  dataRoot: string;
  onEvent: (event: LogEvent) => void;
  fetcher?: typeof fetch;
  toolchainEnv?: NodeJS.ProcessEnv;
  /** Optional portable toolchain root; defaults to `<dataRoot>/toolchains`. */
  toolchainRoot?: string;
  /** Optional directory with bundled Windows driver archives; defaults to `tools/STSW-LINK`. */
  driverRoot?: string;
  /** Injectable hardware boundary; used by integration tests without touching a device. */
  createRuntimes?: CreatePlatformRuntimes;
  /** Initialize desktop discovery once; further scans require refresh or an OS device event. */
  refreshDevices?: boolean;
  /** A debugger owns the physical connection until its session is stopped. */
  hardwareBusy?: () => boolean;
}
export interface CoreService extends CoreApi {
  shutdown(): Promise<void>;
  setProjectRoot(root: string): Promise<void>;
  closeProject(): Promise<void>;
  flashPrepared(config: ProjectConfig, image: RuntimeFirmwareImage): Promise<void>;
  runHardwareAction(action: () => Promise<void>): Promise<void>;
  runInstallation(tool: string, action: (reporter: InstallationReporter) => Promise<void>): Promise<void>;
  /** Coalesce OS device notifications; hardware is enumerated only after operations are idle. */
  notifyDevicesChanged(): void;
  driverStatuses(refresh?: boolean): Promise<DriverStatus[]>;
  installDriver(id: DriverId): Promise<DriverStatus[]>;
}

/** Hardware and filesystem services have one owner, independent of any window. */
export async function createCore(options: CoreOptions): Promise<CoreService> {
  let projectRoot = '';
  let config = getBoardAdapter('auto').createConfig();
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
  const installation = new InstallationTracker(options.onEvent);
  const emit = (message: string, level: LogEvent['level'] = 'info', kind: LogEvent['kind'] = 'log') =>
    options.onEvent(installation.capture({ kind, level, message, time: new Date().toISOString() }));
  const serial = new SerialConnection(
    (data) => emit(data, 'info', 'serial'),
    (error) => emit(error.message, 'error', 'serial'),
    (open) =>
      emit(
        open ? 'status.serialConnected' : 'status.serialDisconnected',
        open ? 'success' : 'info',
        'status',
      ),
  );
  const drivers = new Drivers({
    archiveRoot: options.driverRoot ?? path.join(process.cwd(), 'tools', 'STSW-LINK'),
    dataRoot: options.dataRoot,
    log: (line, level = 'info') => emit(line, level),
    onProgress: installation.progress,
    signal: lifecycle.signal,
  });
  let debugProbes: DebugProbeInfo[] = [];
  let detection: DetectionScan = { candidates: [], unavailablePlatforms: [] };
  let ports: PortInfo[] = [];
  let portsInitialized = false;
  let devicesDirty = !!options.refreshDevices;
  let deviceRevision = 0;
  let deviceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingDeviceScan: Promise<DetectionScan> | undefined;
  let probeState: NonNullable<AppState['connections']>['probes'] = { state: 'unknown' };
  const requireHardware = () => {
    if (options.hardwareBusy?.()) throw new Error('error.debuggerOwnsDevice');
  };
  const closeSerial = async () => {
    await serial.close();
  };
  const clearMissingSelection = (livePorts?: PortInfo[], liveProbes?: DebugProbeInfo[]) => {
    let changed = false;
    if (
      livePorts &&
      config.port &&
      !livePorts.some((port) => port.path === config.port) &&
      serial.state.port !== config.port
    ) {
      config = { ...config, port: '' };
      changed = true;
      if (config.boardId === 'auto' && config.programmer?.transport === 'serial')
        config.programmer = { ...config.programmer, transport: 'auto' };
    }
    if (
      liveProbes &&
      config.programmer?.serialNumber &&
      !liveProbes.some(
        (probe) => probe.serialNumber.toLowerCase() === config.programmer!.serialNumber.toLowerCase(),
      )
    ) {
      config = {
        ...config,
        programmer: {
          ...config.programmer,
          serialNumber: '',
          ...(config.boardId === 'auto' ? { transport: 'auto' as const } : {}),
        },
      };
      changed = true;
    }
    if (changed) emit('status.deviceSelectionCleared', 'warning', 'status');
  };
  const refreshPorts = async (clearSelection = !busy) => {
    portsInitialized = true;
    try {
      ports = await SerialConnection.list();
      if (clearSelection) clearMissingSelection(ports);
    } catch (error) {
      // A failed enumeration is not evidence that previously seen devices disappeared.
      emit(
        'status.portEnumerationUnavailable ' + (error instanceof Error ? error.message : String(error)),
        'warning',
      );
    }
    return structuredClone(ports);
  };

  const withLock = async <T>(action: () => Promise<T>): Promise<T> => {
    if (lifecycle.signal.aborted) throw new Error('error.operationCancelled');
    if (busy) throw new Error('error.busy');
    busy = true;
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const warning = new Set([
        'error.selectPort',
        'error.portUnavailable',
        'error.selectDebugProbe',
        'error.stm32ProbeRequired',
        'error.buildRequired',
        'error.detectBoardFirst',
        'error.selectCompilePlatform',
        'error.noWorkspace',
        'error.debuggerOwnsDevice',
        'error.serialClosed',
      ]).has(message.split(/\s/)[0]);
      emit(message, warning ? 'warning' : 'error');
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
  const host: RuntimeHost = {
    dataRoot: options.dataRoot,
    toolchainRoot: options.toolchainRoot,
    fetcher: options.fetcher,
    env: options.toolchainEnv,
    signal: lifecycle.signal,
    runCommand,
    emit,
    installationProgress: installation.progress,
    projectRoot: requireWorkspace,
    readProjectFiles: () => readProjectFiles(requireWorkspace()),
    resolveWorkspacePath: (relative, flags) => safeWorkspacePath(requireWorkspace(), relative, flags),
    async resetDirectory(relative) {
      if (relative !== '.blode/build' && !relative.startsWith('.blode/staging/'))
        throw new Error('error.invalidPath');
      const root = requireWorkspace();
      const target = await safeWorkspacePath(root, relative, { internal: true });
      const resolvedRelative = path.relative(root, target).replaceAll('\\', '/');
      if (
        resolvedRelative !== relative ||
        path.isAbsolute(resolvedRelative) ||
        resolvedRelative.startsWith('..')
      )
        throw new Error('error.invalidPath');
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target, { recursive: true });
      return target;
    },
    // A full scan reads COM ports once; serial-platform discovery shares that snapshot.
    listPorts: () => (pendingDeviceScan ? Promise.resolve(structuredClone(ports)) : refreshPorts()),
    requirePort,
    closeSerial,
  };
  const runtimes = (options.createRuntimes ?? createPlatformRuntimes)(host);
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  if (runtimeById.size !== runtimes.length) throw new Error('error.invalidPlatformRegistry');
  const runtimeFor = (id: string) => {
    const runtime = runtimeById.get(id);
    if (!runtime) throw new Error('errors.unknownBoard');
    return runtime;
  };
  const invalidateRuntimes = () => runtimes.forEach((runtime) => runtime.invalidate());
  const selectedTransport = (value: ProjectConfig = config) => value.programmer?.transport ?? 'auto';
  const toolchainStatus = async (refresh = false): Promise<ToolchainStatus> => {
    const active =
      config.boardId !== 'auto'
        ? runtimeFor(config.boardId)
        : runtimes.find((runtime) => runtime.transport === selectedTransport());
    if (active) return active.status(config, refresh);
    const statuses = await Promise.all(runtimes.map((runtime) => runtime.status(config, refresh)));
    const combined: ToolchainStatus = {
      arduinoCli: false,
      esp32Core: false,
      python: false,
      esptool: false,
      versions: {},
    };
    for (const status of statuses) {
      for (const key of [
        'arduinoCli',
        'esp32Core',
        'python',
        'esptool',
        'stlink',
        'armCompiler',
        'gnuArm',
      ] as const)
        combined[key] ||= !!status[key];
      Object.assign(combined.versions, status.versions);
    }
    return combined;
  };
  const scan = async (): Promise<DetectionScan> => {
    requireHardware();
    if (pendingDeviceScan) return pendingDeviceScan;
    const revision = deviceRevision;
    pendingDeviceScan = (async () => {
      await refreshPorts(true);
      await drivers.statuses(true);
      const scanned = await Promise.allSettled(runtimes.map((runtime) => runtime.discover(config)));
      const candidates: DetectionCandidate[] = [];
      const unavailablePlatforms: string[] = [];
      scanned.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          for (const candidate of result.value) {
            if (
              candidate.platformId !== runtimes[index].id ||
              candidate.transport !== runtimes[index].transport
            )
              throw new Error('error.invalidPlatformRegistry');
            if (!candidates.some((existing) => existing.id === candidate.id)) candidates.push(candidate);
          }
        } else {
          unavailablePlatforms.push(runtimes[index].id);
          // Keep the last successful result when a tool is temporarily busy/unavailable.
          candidates.push(
            ...detection.candidates.filter((candidate) => candidate.platformId === runtimes[index].id),
          );
        }
      });
      const stlinkResults = scanned.filter((_result, index) => runtimes[index].transport === 'stlink');
      const stlinkFailed = stlinkResults.find((result) => result.status === 'rejected');
      const checkedAt = new Date().toISOString();
      probeState =
        stlinkFailed?.status === 'rejected'
          ? {
              state: 'unavailable',
              checkedAt,
              error:
                stlinkFailed.reason instanceof Error
                  ? stlinkFailed.reason.message
                  : String(stlinkFailed.reason),
            }
          : { state: 'ready', checkedAt };
      const foundProbes = candidates.flatMap((candidate) =>
        candidate.debugProbe ? [candidate.debugProbe] : [],
      );
      debugProbes = foundProbes.map((probe) => ({
        ...debugProbes.find((old) => old.serialNumber.toLowerCase() === probe.serialNumber.toLowerCase()),
        ...probe,
      }));
      if (!stlinkFailed && stlinkResults.length) clearMissingSelection(undefined, debugProbes);
      detection = { candidates, unavailablePlatforms };
      if (revision === deviceRevision) devicesDirty = false;
      emit('status.devicesChanged', 'info', 'status');
      return structuredClone(detection);
    })();
    try {
      return await pendingDeviceScan;
    } finally {
      pendingDeviceScan = undefined;
    }
  };
  const scheduleDeviceRefresh = (delay = 350) => {
    clearTimeout(deviceRefreshTimer);
    if (lifecycle.signal.aborted || !devicesDirty) return;
    deviceRefreshTimer = setTimeout(async () => {
      deviceRefreshTimer = undefined;
      if (lifecycle.signal.aborted || !devicesDirty) return;
      // This only checks ownership flags; it never polls devices while a tool owns them.
      if (busy || options.hardwareBusy?.()) {
        scheduleDeviceRefresh(500);
        return;
      }
      try {
        await scan();
      } catch (error) {
        // Retry only on another device notification or an explicit user refresh.
        devicesDirty = false;
        emit(error instanceof Error ? error.message : String(error), 'warning');
      }
      if (devicesDirty) scheduleDeviceRefresh();
    }, delay);
    deviceRefreshTimer.unref();
  };
  const connectedUnavailable = async () => {
    const statuses = await drivers.statuses();
    return detection.unavailablePlatforms.filter((id) =>
      getBoardAdapter(id).definition.requiredDrivers?.some((driver) =>
        statuses.some((status) => status.id === driver && status.connected),
      ),
    );
  };
  const autoSelection = async (port?: string, source: ProjectConfig = config) => {
    if (port) {
      const runtime = runtimes.find((item) => item.transport === 'serial');
      if (!runtime) throw new Error('error.noDetectionDevices');
      return { runtime, selection: { port } };
    }
    const transport = selectedTransport(source);
    const serialNumber = source.programmer?.serialNumber;
    const explicit = transport === 'serial' ? source.port : transport === 'stlink' ? serialNumber : '';
    if (explicit) {
      const runtime = runtimes.find((item) => item.transport === transport);
      if (!runtime) throw new Error('error.noDetectionDevices');
      return { runtime, selection: transport === 'serial' ? { port: explicit } : { serialNumber: explicit } };
    }
    const scanned = await scan();
    const candidates = scanned.candidates.filter(
      (candidate) =>
        !scanned.unavailablePlatforms.includes(candidate.platformId) &&
        (transport === 'auto' || candidate.transport === transport),
    );
    if (candidates.length > 1) throw new Error('error.multipleDetectionDevices');
    if (!candidates.length) {
      const missing = await connectedUnavailable();
      if (missing.length) throw new Error('error.detectionToolsMissing ' + missing.join(', '));
      throw new Error('error.noDetectionDevices');
    }
    const candidate = candidates[0];
    return {
      runtime: runtimeFor(candidate.platformId),
      selection: { port: candidate.port, serialNumber: candidate.serialNumber },
    };
  };
  const fingerprint = async (
    source = undefined as Awaited<ReturnType<typeof readProjectFiles>> | undefined,
  ) => {
    source ??= await readProjectFiles(projectRoot);
    const buildConfig = (value: ProjectConfig) => ({
      ...value,
      port: '',
      baudRate: 0,
      ...(value.programmer ? { programmer: { ...value.programmer, serialNumber: '', frequencyKhz: 0 } } : {}),
    });
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, stable(item)]),
            )
          : value;
    const inputs = source.map((file) => {
      if (file.path !== PROJECT_MARKER) return file;
      try {
        const descriptor = parseProjectDescriptor(JSON.parse(file.content));
        return {
          ...file,
          content: JSON.stringify(
            stable({ config: buildConfig(descriptor.config), build: descriptor.build }),
          ),
        };
      } catch {
        // Invalid descriptors still change the fingerprint; never ignore their contents.
        return file;
      }
    });
    // The be descriptor repeats the configuration. Normalize its runtime options
    // too, while retaining all build inputs and the expected target chip identity.
    return createHash('sha256')
      .update(JSON.stringify(stable(buildConfig(config))))
      .update(JSON.stringify(inputs))
      .digest('hex');
  };
  const currentFingerprint = async (source?: Awaited<ReturnType<typeof readProjectFiles>>) => {
    let value = await fingerprint(source);
    const runtime = runtimeById.get(config.boardId);
    const extra = runtime?.buildInputs ? await runtime.buildInputs(config, projectBuild) : [];
    for (const input of [...new Set([...(runtime?.sourceInputs ?? []), ...extra])].sort()) {
      const bytes = await fs
        .readFile(await safeWorkspacePath(projectRoot, input))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
      value = createHash('sha256')
        .update(value)
        .update(bytes ? 'present' : 'missing')
        .update(bytes ?? input)
        .digest('hex');
    }
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
  const api: CoreService = {
    async getState(): Promise<AppState> {
      if (devicesDirty && !busy && !options.hardwareBusy?.()) await scan();
      else if (!portsInitialized) await refreshPorts();
      const [toolchain, driverStatuses] = await Promise.all([toolchainStatus(), drivers.statuses()]);
      const connections = { serial: serial.state, probes: structuredClone(probeState) };
      if (!projectRoot)
        return {
          projectRoot: '',
          installation: installation.snapshot(),
          workspaceOpen: false,
          connections,
          config: structuredClone(config),
          build: structuredClone(projectBuild),
          files: [],
          inventory: { entries: [], totalBytes: 0, fileCount: 0, directoryCount: 0, truncated: false },
          boards: listBoards(),
          ports,
          debugProbes: structuredClone(debugProbes),
          detection: structuredClone(detection),
          toolchain,
          drivers: driverStatuses,
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
        installation: installation.snapshot(),
        workspaceOpen: true,
        connections,
        config: structuredClone(config),
        build: structuredClone(projectBuild),
        files,
        inventory,
        boards: listBoards(),
        ports,
        debugProbes: structuredClone(debugProbes),
        detection: structuredClone(detection),
        toolchain,
        drivers: driverStatuses,
        lastBuild: lastBuild ? structuredClone(lastBuild) : null,
        buildStale,
        pipe: { endpoint: '', tokenFile: '' },
        web: { endpoint: '', tokenFile: '', allowExternal: false },
      };
    },
    async listPorts() {
      const value = await refreshPorts();
      emit('status.devicesChanged', 'info', 'status');
      return value;
    },
    async listDebugProbes() {
      await pendingDeviceScan;
      return withLock(async () => {
        requireHardware();
        try {
          const connections = (
            await Promise.all(
              runtimes
                .filter((runtime) => runtime.transport === 'stlink')
                .map((runtime) => runtime.discover(config)),
            )
          ).flat();
          debugProbes = connections.flatMap((connection) =>
            connection.debugProbe ? [connection.debugProbe] : [],
          );
          probeState = { state: 'ready', checkedAt: new Date().toISOString() };
          clearMissingSelection(undefined, debugProbes);
          detection.candidates = [
            ...detection.candidates.filter((candidate) => candidate.transport !== 'stlink'),
            ...connections,
          ];
          detection.unavailablePlatforms = detection.unavailablePlatforms.filter(
            (id) => runtimeById.get(id)?.transport !== 'stlink',
          );
          emit('status.devicesChanged', 'info', 'status');
          return structuredClone(debugProbes);
        } catch (error) {
          probeState = {
            state: 'unavailable',
            checkedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
          emit('status.probeEnumerationUnavailable', 'warning');
          return structuredClone(debugProbes);
        }
      });
    },
    async scanDevices() {
      await pendingDeviceScan;
      return withLock(scan);
    },
    notifyDevicesChanged() {
      deviceRevision += 1;
      devicesDirty = true;
      drivers.invalidate();
      scheduleDeviceRefresh();
    },
    async saveFile(relative, content) {
      return withLock(async () => {
        let descriptor: ReturnType<typeof parseProjectDescriptor> | undefined;
        if (relative.toLowerCase() === PROJECT_MARKER) {
          try {
            descriptor = parseProjectDescriptor(JSON.parse(content));
          } catch {
            throw new Error('error.invalidProjectDescriptor');
          }
        }
        await writeProjectFile(requireWorkspace(), relative, content);
        if (descriptor) {
          config = descriptor.config;
          projectBuild = descriptor.build;
          invalidateRuntimes();
        }
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
        projectBuild = (await loadProjectDescriptor(requireWorkspace(), config)).build;
        invalidateRuntimes();
        emit('status.configSaved', 'success');
      });
    },
    async setBuildEntry(relative) {
      return withLock(async () => {
        projectBuild = await persistBuildEntry(requireWorkspace(), config, relative);
        emit('status.buildEntrySet', 'success', 'status');
      });
    },
    async build() {
      return withLock(async () => {
        requireWorkspace();
        if (config.boardId === 'auto') {
          const candidates = (
            await Promise.all(runtimes.map((runtime) => runtime.projectConfig?.(config, projectBuild)))
          ).filter((value): value is ProjectConfig => !!value);
          if (candidates.length !== 1) throw new Error('error.selectCompilePlatform');
          config = parseConfig(candidates[0]);
          await persistConfig(projectRoot, config);
          emit('status.offlinePlatformSelected', 'info', 'status');
        }
        const adapter = getBoardAdapter(config.boardId);
        adapter.validateConfig(config);
        const before = await currentFingerprint();
        emit('status.buildStarted', 'info', 'status');
        const result = await runtimeFor(config.boardId).build(config, projectBuild);
        if (result.success && before === (await currentFingerprint())) {
          lastBuild = result;
          builtFingerprint = before;
          artifactHashes = await hashArtifacts(projectRoot, result.artifacts);
          await persistSuccessfulBuild();
        } else if (result.success) {
          result.success = false;
          emit('error.sourceChanged', 'error');
        }
        emit(
          result.success ? 'status.buildSucceeded' : 'status.buildFailed',
          result.success ? 'success' : 'error',
          'status',
        );
        return structuredClone(result);
      });
    },
    async runHardwareAction(action) {
      await pendingDeviceScan;
      return withLock(async () => {
        requireHardware();
        await action();
      });
    },
    async runInstallation(tool, action) {
      await pendingDeviceScan;
      return withLock(async () => {
        requireHardware();
        await installation.run(tool, () =>
          action({
            progress: installation.progress,
            log: (line) => emit(line),
            fetcher: options.fetcher,
            signal: lifecycle.signal,
          }),
        );
        invalidateRuntimes();
      });
    },
    async flashPrepared(value, image) {
      return withLock(async () => {
        await pendingDeviceScan;
        requireHardware();
        const target = parseConfig(value);
        if (target.boardId === 'auto') throw new Error('error.detectBoardFirst');
        const runtime = runtimeFor(target.boardId);
        if (!runtime.flashPrepared) throw new Error('error.preparedFlashUnsupported');
        if (
          !path.isAbsolute(image.path) ||
          !Number.isSafeInteger(image.address) ||
          image.address < 0 ||
          !Number.isSafeInteger(image.size) ||
          image.size < 1 ||
          !/^[a-f0-9]{64}$/.test(image.sha256)
        )
          throw new Error('error.invalidFirmwareImage');
        emit('status.flashStarted', 'info', 'status');
        await runtime.flashPrepared(target, image);
        emit('status.flashSucceeded', 'success', 'status');
      });
    },
    async flash() {
      return withLock(async () => {
        await pendingDeviceScan;
        requireHardware();
        requireWorkspace();
        if (config.boardId === 'auto') throw new Error('error.detectBoardFirst');
        getBoardAdapter(config.boardId).validateConfig(config);
        if (!lastBuild?.success || !builtFingerprint || builtFingerprint !== (await currentFingerprint()))
          throw new Error('error.buildRequired');
        if (!(await artifactsMatch(projectRoot, artifactHashes))) throw new Error('error.artifactChanged');
        emit('status.flashStarted', 'info', 'status');
        await runtimeFor(config.boardId).flash(config, lastBuild);
        emit('status.flashSucceeded', 'success', 'status');
      });
    },
    async probe(port, requestedConfig) {
      return withLock(async () => {
        await pendingDeviceScan;
        requireHardware();
        // A config override lets the welcome page test an explicitly selected
        // board/probe before a project exists; normal calls keep the core config.
        const source = requestedConfig ? parseConfig(requestedConfig) : config;
        const active =
          source.boardId === 'auto'
            ? await autoSelection(port, source)
            : {
                runtime: runtimeFor(source.boardId),
                selection: { port, serialNumber: source.programmer?.serialNumber },
              };
        const result = await active.runtime.probe(source, active.selection);
        if (result.config.boardId !== active.runtime.id) throw new Error('error.invalidPlatformRegistry');
        const next = parseConfig(result.config);
        if (projectRoot) await persistConfig(projectRoot, next);
        config = next;
        if (result.debugProbes) {
          debugProbes = structuredClone(result.debugProbes);
          probeState = { state: 'ready', checkedAt: new Date().toISOString() };
        }
        invalidateRuntimes();
        return result.output;
      });
    },
    async installToolchain() {
      return withLock(async () => {
        return installation.run(
          config.boardId === 'auto' ? 'Toolchain' : runtimeFor(config.boardId).id,
          async () => {
            await pendingDeviceScan;
            requireHardware();
            let runtime =
              config.boardId !== 'auto'
                ? runtimeFor(config.boardId)
                : runtimes.find((item) => item.transport === selectedTransport());
            if (!runtime) {
              const scanned = await scan();
              if (scanned.candidates.length === 1) runtime = runtimeFor(scanned.candidates[0].platformId);
              else if (scanned.candidates.length > 1) throw new Error('error.multipleDetectionDevices');
              else {
                const missing = await connectedUnavailable();
                if (missing.length === 1) runtime = runtimeFor(missing[0]);
              }
            }
            if (!runtime) throw new Error('error.selectPlatformForTools');
            await runtime.install(config);
            invalidateRuntimes();
            await scan();
            return toolchainStatus(true);
          },
        );
      });
    },
    async driverStatuses(refresh = false) {
      return drivers.statuses(refresh);
    },
    async installDriver(id) {
      return withLock(async () => {
        requireHardware();
        return installation.run('ST-Link driver', () => drivers.install(id));
      });
    },
    async serialOpen(port, baudRate = 115200, options) {
      return withLock(async () => {
        if (!Number.isInteger(baudRate) || baudRate < 110 || baudRate > 4_000_000)
          throw new Error('error.invalidBaudRate');
        await serial.open(await requirePort(port), baudRate, options);
      });
    },
    async serialClose() {
      return withLock(async () => closeSerial());
    },
    async serialWrite(data, encoding = 'utf8') {
      return withLock(async () => serial.write(data, encoding));
    },
    async setProjectRoot(root) {
      return withLock(async () => {
        const resolved = await fs.realpath(root);
        // Reading/creating `be` is the explicit project-area association step.
        await ensureProjectMarker(resolved);
        const loaded = await loadProjectDescriptor(resolved, getBoardAdapter('auto').createConfig());
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
        invalidateRuntimes();
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
      clearTimeout(deviceRefreshTimer);
      stopWatching();
      await serial.close();
    },
    async closeProject() {
      return withLock(async () => {
        await closeSerial();
        stopWatching();
        projectRoot = '';
        projectBuild = {};
        lastBuild = null;
        builtFingerprint = '';
        artifactHashes = {};
        emit('status.projectClosed', 'success', 'status');
      });
    },
  };
  return api;
}
