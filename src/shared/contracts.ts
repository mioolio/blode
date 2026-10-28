/** Public boundary shared by Electron IPC, named-pipe RPC and board plugins. */
export interface Partition {
  id: string;
  name: string;
  type: 'app' | 'data' | 'system';
  offset: number;
  size: number;
}
export interface ProjectConfig {
  version: 1;
  name: string;
  boardId: string;
  port: string;
  baudRate: number;
  flashSize: number;
  partitions: Partition[];
  toolchain: {
    mode: 'managed' | 'custom';
    arduinoCli: string;
    python: string;
    additionalUrls: string[];
    fqbn: string;
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
export interface BoardDefinition {
  id: string;
  name: string;
  family: string;
  descriptionKey: string;
  /** Common retail capacities only; custom values stay behind an explicit opt-in. */
  flashSizes: number[];
  /** Allow a board-specific custom capacity instead of enumerating every value. */
  customFlashSize?: boolean;
  /** Upload speeds the adapter is known to work with. */
  baudRates?: number[];
  recommendedBaudRate?: number;
  ramSize: number;
  defaultConfig: Partial<ProjectConfig>;
  capabilities: string[];
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
  versions: Record<string, string>;
}
export interface AppState {
  /** Empty until the user opens a project area (a folder containing the `be` marker). */
  projectRoot: string;
  workspaceOpen: boolean;
  config: ProjectConfig;
  files: ProjectFile[];
  inventory: ProjectInventory;
  boards: BoardDefinition[];
  ports: PortInfo[];
  toolchain: ToolchainStatus;
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
  saveFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  renameEntry(from: string, to: string): Promise<void>;
  deleteEntry(path: string): Promise<void>;
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
