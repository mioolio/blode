/** Public boundary shared by Electron IPC, named-pipe RPC and board plugins. */
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
  partitions: Partition[];
  /** Debug transport is separate from the COM port used by the serial monitor. */
  programmer?: {
    transport: 'auto' | 'serial' | 'stlink';
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
  transport: 'serial' | 'stlink';
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
  /** Project-relative source file/directory; '.' selects the workspace root. */
  entry?: string;
  sketch?: string;
  files?: string[];
}
export interface BoardDefinition {
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
export interface AppState {
  /** Empty until the user opens a project area (a folder containing the `be` marker). */
  projectRoot: string;
  workspaceOpen: boolean;
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
  kind: 'log' | 'serial' | 'status';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  time: string;
}
export interface CoreApi {
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
  probe(port?: string): Promise<string>;
  installToolchain(): Promise<ToolchainStatus>;
  serialOpen(port?: string, baudRate?: number): Promise<void>;
  serialClose(): Promise<void>;
  serialWrite(data: string): Promise<void>;
}
export interface DesktopApi extends CoreApi {
  /** Native save dialog on desktop; browser clients initiate a download. */
  exportProbeLog(content: string): Promise<import('./probe-log').ProbeLogExportResult>;
  /** Driver setup is a native, machine-wide action; browser clients cannot request it. */
  installDriver(id: DriverId): Promise<DriverStatus[]>;
  refreshDrivers(): Promise<DriverStatus[]>;
  selectProject(): Promise<boolean>;
  /** Native file picker for a `be` marker; opens the folder that contains it. */
  selectProjectMarker(): Promise<boolean>;
  revealEntry(path: string): Promise<void>;
  /** Desktop publishes unsaved buffers; browser clients receive them over SSE. */
  publishDrafts(drafts: Record<string, string>): void;
  onDrafts(callback: (drafts: Record<string, string>) => void): () => void;
  onEvent(callback: (event: LogEvent) => void): () => void;
  windowAction(action: 'minimize' | 'maximize' | 'close'): void;
}
export const IPC_CHANNEL = 'blode:request';
export const EVENT_CHANNEL = 'blode:event';
export const DRAFTS_CHANNEL = 'blode:drafts';
