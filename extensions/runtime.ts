import type {
  BuildResult,
  DebugProbeInfo,
  DetectionCandidate,
  LogEvent,
  ProjectConfig,
  ProjectFile,
  ToolchainStatus,
  ProjectBuildInputs,
} from '../src/shared/contracts.js';

/** Stable host capabilities provided to statically registered, trusted platform packages. */
export interface RuntimeCommandResult {
  code: number;
  output: string;
  stdout?: string;
  stderr?: string;
}
export interface RuntimeRunOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}
export interface RuntimeHost {
  dataRoot: string;
  toolchainRoot?: string;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  runCommand(command: string, args: string[], options?: RuntimeRunOptions): Promise<RuntimeCommandResult>;
  emit(message: string, level?: LogEvent['level'], kind?: LogEvent['kind']): void;
  projectRoot(): string;
  readProjectFiles(): Promise<ProjectFile[]>;
  resolveWorkspacePath(relative: string, options?: { internal?: boolean }): Promise<string>;
  resetDirectory(relative: string): Promise<string>;
  listPorts(): Promise<import('../src/shared/contracts.js').PortInfo[]>;
  requirePort(port?: string): Promise<string>;
  closeSerial(): Promise<void>;
}
export interface PlatformProbeResult {
  output: string;
  config: ProjectConfig;
  debugProbes?: DebugProbeInfo[];
}
export interface PlatformRuntime {
  readonly id: string;
  readonly transport: 'serial' | 'stlink';
  /** Project-relative binary inputs not represented by the source editor. */
  readonly sourceInputs: readonly string[];
  projectConfig?(config: ProjectConfig, build: ProjectBuildInputs): Promise<ProjectConfig | null>;
  /** Extra inputs read by a compiler, including sources outside the editor's display limits. */
  buildInputs?(config: ProjectConfig, build: ProjectBuildInputs): Promise<readonly string[]>;
  status(config: ProjectConfig, refresh?: boolean): Promise<ToolchainStatus>;
  install(config: ProjectConfig): Promise<ToolchainStatus>;
  discover(config: ProjectConfig): Promise<DetectionCandidate[]>;
  probe(
    config: ProjectConfig,
    selection?: { port?: string; serialNumber?: string },
  ): Promise<PlatformProbeResult>;
  build(config: ProjectConfig, build: ProjectBuildInputs): Promise<BuildResult>;
  flash(config: ProjectConfig, build: BuildResult): Promise<void>;
  invalidate(): void;
}
export type CreatePlatformRuntimes = (host: RuntimeHost) => PlatformRuntime[];
