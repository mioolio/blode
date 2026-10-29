/** Public boundary shared by Electron IPC, named-pipe RPC and board plugins. */
import type { AiAssistanceApi } from './ai';
import type { CollaborationApi } from './collaboration';
import type { WorkbenchApi } from './workbench';
import type { GitApi } from './git';
import type { ToolVersionsApi } from './tool-versions';
import type { HostWorkspaceApi } from './host-workspace';
import type { ProjectPackageApi } from './project-package';
import type { TerminalApi } from './terminal';
import type { LanguageApi } from './language';
import type { DesktopLifecycleApi } from './desktop-lifecycle';
import type {
  RuntimePluginManifest,
  RuntimePluginsApi,
  RuntimePluginsState,
  RuntimeTransport,
} from './plugins';
import type { BuildSettings } from './build-settings';
export interface Partition {
  id: string;
  name: string;
  type: 'app' | 'data' | 'system';
  offset: number;
  size: number;
  /** Optional `#RRGGBB` presentation color; layout semantics stay in type/range. */
  color?: string;
}
export interface ProjectConfig {
  version: 1;
  name: string;
  boardId: string;
  port: string;
  baudRate: number;
  flashSize: number;
  /**
   * The user chose the capacity explicitly. Platforms that honour it must not
   * replace the value with a probe report on re-identification.
   */
  flashSizeOverride?: boolean;
  runtime?: {
    deviceId?: string;
    values?: Record<string, string | number | boolean>;
    forceCompiler?: boolean;
    compilerRuntime?: string;
    disabledCapabilities?: string[];
  };
  partitions: Partition[];
  debugger?: {
    gdbPath?: string;
    serverPath?: string;
    scriptsPath?: string;
    serialNumber?: string;
    frequencyKhz?: number;
  };
  /** Debug transport is separate from the COM port used by the serial monitor. */
  programmer?: {
    transport: 'auto' | RuntimeTransport;
    serialNumber: string;
    frequencyKhz: number;
    targetChipId?: string;
  };
  toolchain: {
    mode: 'managed' | 'custom';
    arduinoCli: string;
    python: string;
    additionalUrls: string[];
    fqbn: string;
    /** Directory containing st-info and st-flash; empty uses the managed tools or PATH. */
    stlinkDirectory?: string;
    /** Portable Arm Compiler directory; empty discovers tools/armclang or PATH. */
    armCompilerDirectory?: string;
    /** Isolated Arduino package store, including side-by-side core versions. */
    packageDirectory?: string;
  };
}
export interface ProjectFile {
  path: string;
  language: string;
  content: string;
}
/** On-disk project footprint, independent of compiler output. No symlinks are followed. */
export interface WorkspaceEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number;
  editable: boolean;
}
export interface ProjectInventory {
  entries: WorkspaceEntry[];
  totalBytes: number;
  fileCount: number;
  directoryCount: number;
  truncated: boolean;
}
export interface PortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
}
export interface SerialOptions {
  dataBits?: 5 | 6 | 7 | 8;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  stopBits?: 1 | 1.5 | 2;
  flowControl?: 'none' | 'rtscts' | 'xonxoff';
}
export interface DebugProbeInfo {
  serialNumber: string;
  name: string;
  chipId?: string;
  description?: string;
  flashSize?: number;
  ramSize?: number;
}
export interface DetectionCandidate {
  id: string;
  platformId: string;
  transport: RuntimeTransport;
  deviceId?: string;
  name: string;
  port?: string;
  serialNumber?: string;
  debugProbe?: DebugProbeInfo;
}
export interface DetectionScan {
  candidates: DetectionCandidate[];
  unavailablePlatforms: string[];
}
export interface ProjectBuildInputs {
  settings?: BuildSettings;
  /** C language rules and compiler dialect. C++ keeps its own platform settings. */
  cStandard?: 'c99' | 'c11' | 'c17' | 'c23';
  /** Project-relative source file/directory; '.' selects the workspace root. */
  entry?: string;
  sketch?: string;
  files?: string[];
}
export interface BoardDefinition {
  pluginId?: string;
  runtimePlugin?: RuntimePluginManifest;
  id: string;
  name: string;
  family: string;
  descriptionKey: string;
  /** Common retail capacities only; custom values stay behind an explicit opt-in. */
  flashSizes: number[];
  /** Allow a board-specific custom capacity instead of enumerating every value. */
  customFlashSize?: boolean;
  /**
   * Presentation facts for the Flash map. Editing is still gated by the
   * `partitions` capability; fixed-layout platforms use this for a read-only view.
   */
  layout?: {
    /** Absolute address of Flash offset 0. */
    baseAddress: number;
  };
  /** Upload speeds the adapter is known to work with. */
  baudRates?: number[];
  recommendedBaudRate?: number;
  /** Case-insensitive chip names reported by the probe; empty means never auto-selected. */
  probePatterns?: string[];
  ramSize: number;
  defaultConfig: Partial<ProjectConfig>;
  capabilities: string[];
  requiredDrivers?: DriverId[];
}
export interface BuildResult {
  success: boolean;
  flashUsed: number;
  ramUsed: number;
  flashTotal: number;
  ramTotal: number;
  artifacts: string[];
  timestamp: string;
  output: string;
}
export interface ToolchainStatus {
  arduinoCli: boolean;
  esp32Core: boolean;
  python: boolean;
  esptool: boolean;
  stlink?: boolean;
  armCompiler?: boolean;
  /** Managed GNU Arm GCC used when Arm Compiler 6 is not installed. */
  gnuArm?: boolean;
  versions: Record<string, string>;
}
/** Debug probes installed through a vendor INF package, currently only ST-Link on Windows. */
export type DriverId = 'stlink';
export type DriverState = 'unsupported' | 'missing' | 'device-unbound' | 'installed' | 'ready';
export interface DriverStatus {
  id: DriverId;
  name: string;
  /** False on platforms where the packaged Windows driver does not apply. */
  supported: boolean;
  /** A matching driver package is staged in the Windows driver store. */
  installed: boolean;
  /** A matching probe is currently attached, whether or not its driver works. */
  connected: boolean;
  deviceCount: number;
  version: string;
  state: DriverState;
  /** The bundled installer archive exists and can be used for (re)installation. */
  available: boolean;
}
export interface RecentProject {
  path: string;
  name: string;
  /** False when the folder or its `be` marker disappeared. */
  available: boolean;
}
export interface ReopenProjectResult {
  status: 'opened' | 'missing' | 'none';
  recent?: RecentProject;
}
export interface InstallationProgress {
  tool: string;
  phase: 'starting' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'completed' | 'failed';
  receivedBytes?: number;
  totalBytes?: number;
}
export interface InstallationState extends InstallationProgress {
  id: string;
  status: 'running' | 'completed' | 'failed';
  updatedAt: string;
  logs: LogEvent[];
}
export interface AppState {
  language?: import('./module-languages').ModuleLanguageState;
  runtimePlugins?: RuntimePluginsState;
  /** Initial desktop discovery is running; tool/driver absence is not yet known. */
  initializing?: boolean;
  recentLogs?: LogEvent[];
  installation?: InstallationState;
  connections?: {
    serial: { open: boolean; port: string; baudRate: number; options?: SerialOptions };
    probes: { state: 'unknown' | 'ready' | 'unavailable'; checkedAt?: string; error?: string };
  };
  recentProjects?: RecentProject[];
  /** Empty until the user opens a project area (a folder containing the `be` marker). */
  projectRoot: string;
  workspaceOpen: boolean;
  /** Last workspace chosen on this machine; absent in browser-only sessions. */
  recentProject?: RecentProject | null;
  config: ProjectConfig;
  build: ProjectBuildInputs;
  files: ProjectFile[];
  inventory: ProjectInventory;
  boards: BoardDefinition[];
  ports: PortInfo[];
  debugProbes: DebugProbeInfo[];
  detection: DetectionScan;
  toolchain: ToolchainStatus;
  drivers: DriverStatus[];
  lastBuild: BuildResult | null;
  buildStale: boolean;
  pipe: { endpoint: string; tokenFile: string };
  web: { endpoint: string; tokenFile: string; allowExternal: boolean };
}
export interface LogEvent {
  sequence?: number;
  kind: 'log' | 'serial' | 'status' | 'terminal';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  time: string;
  installation?: Omit<InstallationState, 'logs'>;
  /** Byte updates refresh the progress bar without flooding ordinary output. */
  progressOnly?: boolean;
}
export interface CoreApi {
  /** Optional native workbench capabilities exposed through the authenticated automation router. */
  automationInvoke?(method: string, params: Record<string, unknown>): Promise<unknown>;
  getState(): Promise<AppState>;
  listPorts(): Promise<PortInfo[]>;
  listDebugProbes(): Promise<DebugProbeInfo[]>;
  scanDevices(): Promise<DetectionScan>;
  saveFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  renameEntry(from: string, to: string): Promise<void>;
  deleteEntry(path: string): Promise<void>;
  setBuildEntry(path: string): Promise<void>;
  saveConfig(config: ProjectConfig): Promise<void>;
  build(): Promise<BuildResult>;
  flash(): Promise<void>;
  /** Optional config allows explicit board/probe selection before a workspace is open. */
  probe(port?: string, config?: ProjectConfig): Promise<string>;
  installToolchain(): Promise<ToolchainStatus>;
  serialOpen(port?: string, baudRate?: number, options?: SerialOptions): Promise<void>;
  serialClose(): Promise<void>;
  serialWrite(data: string, encoding?: 'utf8' | 'hex'): Promise<void>;
}
export type FirmwareFormat = 'bin' | 'hex' | 'srec' | 'elf';
export interface PreparedFirmware {
  id: string;
  name: string;
  format: 'bin' | 'hex' | 'srec';
  size: number;
  address: number | null;
  segments: number;
  sha256: string;
}
export interface FirmwareFlashRequest {
  id: string;
  config: ProjectConfig;
  address?: number;
  confirm: true;
}
export interface FirmwareExportResult {
  status: 'saved' | 'cancelled';
  path?: string;
}
export interface DebuggerState {
  profile?: import('./debugger-profiles').DebuggerProfile;
  sessionId?: string;
  instructions?: {
    address: string;
    function?: string;
    offset?: string;
    instruction: string;
    opcodes?: string;
  }[];
  updatedAt?: string;
  programCounter?: string;
  connection: 'disconnected' | 'connecting' | 'stopped' | 'running' | 'error';
  tools: {
    gdb: boolean;
    server: boolean;
    paths?: { gdb: string | null; server: string | null; scripts?: string | null };
  };
  message: string;
  symbols: string;
  registers: { name: string; value: string }[];
  stack: { level: string; function: string; file?: string; line?: string; address: string }[];
  breakpoints: { id: string; location: string }[];
  log: string[];
}
export type DebuggerAction = 'continue' | 'pause' | 'step' | 'next' | 'finish' | 'disconnect';
export interface DebuggerStorage {
  name: string;
  size: number;
  segments: { address: number; size: number; kind: 'flash' | 'ram' | 'other' }[];
  preview: string;
  source: 'elf';
}
export interface DesktopApi
  extends
    CoreApi,
    AiAssistanceApi,
    CollaborationApi,
    WorkbenchApi,
    GitApi,
    ToolVersionsApi,
    HostWorkspaceApi,
    ProjectPackageApi,
    LanguageApi,
    DesktopLifecycleApi,
    RuntimePluginsApi,
    TerminalApi {
  /** Notify the native shell after the first workspace frame has mounted. */
  setTerminalFocus?(focused: boolean): void;
  rendererReady?(): void;
  onWindowAttention?(
    callback: (state: { visible: boolean; focused: boolean; epoch?: number }) => void,
  ): () => void;
  listRecentProjects(): Promise<RecentProject[]>;
  openRecentProject(path: string): Promise<ReopenProjectResult>;
  removeRecentProject(path: string): Promise<void>;
  closeProject(): Promise<void>;
  firmwareExport(format: FirmwareFormat): Promise<FirmwareExportResult>;
  firmwareChoose(): Promise<PreparedFirmware | null>;
  firmwareFlash(request: FirmwareFlashRequest): Promise<void>;
  openDebugger(): Promise<void>;
  debuggerState(config?: ProjectConfig): Promise<DebuggerState>;
  debuggerSymbols(): Promise<string | null>;
  debuggerConnect(config: ProjectConfig): Promise<void>;
  debuggerAction(action: DebuggerAction): Promise<void>;
  debuggerBreakpoint(location: string, removeId?: string): Promise<void>;
  debuggerBreakpoints(locations: string[]): Promise<import('./debugger-edit').DebuggerBreakpointResult[]>;
  debuggerPatch(
    request: import('./debugger-edit').DebuggerPatchRequest,
  ): Promise<import('./debugger-edit').DebuggerPatchResult>;
  debuggerAssemble(address: number, source: string): Promise<string>;
  debuggerMemory(address: number, length: number): Promise<string>;
  debuggerInstallTools(config?: ProjectConfig): Promise<void>;
  debuggerChooseGdb(): Promise<boolean>;
  debuggerStorage(): Promise<DebuggerStorage | null>;
  /** Native save dialog on desktop; browser clients initiate a download. */
  exportProbeLog(content: string): Promise<import('./probe-log').ProbeLogExportResult>;
  /** Driver setup is a native, machine-wide action; browser clients cannot request it. */
  installDriver(id: DriverId): Promise<DriverStatus[]>;
  refreshDrivers(): Promise<DriverStatus[]>;
  selectProject(): Promise<boolean>;
  /** Native file picker for a `be` marker; opens the folder that contains it. */
  selectProjectMarker(): Promise<boolean>;
  /** Reopen the most recently selected workspace without another file dialog. */
  reopenProject(): Promise<ReopenProjectResult>;
  revealEntry(path: string): Promise<void>;
  /** Desktop publishes unsaved buffers; browser clients receive them over SSE. */
  publishDrafts(drafts: Record<string, string>): void;
  onDrafts(callback: (drafts: Record<string, string>) => void): () => void;
  onEvent(callback: (event: LogEvent) => void): () => void;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
}
export const IPC_CHANNEL = 'blode:request';
export const RENDERER_READY_CHANNEL = 'blode:renderer-ready';
export const EVENT_CHANNEL = 'blode:event';
export const DRAFTS_CHANNEL = 'blode:drafts';
export const COLLABORATION_CHANNEL = 'blode:collaboration';
export const UI_COMMAND_CHANNEL = 'blode:ui-command';
