import type { ProjectConfig } from './contracts';

export type ToolVersionKind = 'gnu-arm' | 'arduino-cli' | 'arduino-esp32' | 'stlink';
export interface ToolVersionEntry {
  id: string;
  kind: ToolVersionKind;
  version: string;
  name: string;
  releaseUrl: string;
  downloadUrl?: string;
  installable: boolean;
  installed: boolean;
  directory?: string;
  note?: string;
}
export interface ToolVersionsState {
  platform: string;
  arch: string;
  entries: ToolVersionEntry[];
  installedTools?: InstalledBuildTool[];
}
export interface InstalledBuildTool {
  id: string;
  family: 'gnu-arm' | 'armclang' | 'arduino';
  name: string;
  version: string;
  directory?: string;
  arduinoCli?: string;
  packageDirectory?: string;
  source: 'managed' | 'versioned' | 'custom' | 'path';
  platforms: ('STM32F103C8T6' | 'Esp32_S3_CAM')[];
}
export interface ToolVersionsApi {
  toolVersionsState(): Promise<ToolVersionsState>;
  toolVersionInstall(request: { id: string; confirm: true }): Promise<ToolVersionsState>;
  toolVersionSelect(request: { id: string }): Promise<Partial<ProjectConfig['toolchain']>>;
}
