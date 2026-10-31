import type { ProjectConfig } from './contracts';

export type ToolVersionKind = 'gnu-arm' | 'arduino-cli' | 'arduino-esp32' | 'stlink' | 'clangd';
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
  archives?: ToolPackageResult[];
  platform: string;
  arch: string;
  entries: ToolVersionEntry[];
  installedTools?: InstalledBuildTool[];
  localTools?: LocalToolchain[];
}
export interface LocalToolchain {
  id: string;
  name: string;
  version: string;
  kind: ToolVersionKind | 'armclang';
  directory?: string;
  source: InstalledBuildTool['source'];
  exportable: boolean;
  binaryDirectory?: string;
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
  toolVersionDownload(request: { id: string; confirm: true }): Promise<ToolPackageResult>;
  toolVersionExport(request: { id: string; confirm: true }): Promise<ToolPackageResult>;
  toolVersionImport(request: { path: string; confirm: true }): Promise<ToolVersionsState>;
  toolVersionPackageSave(id: string): Promise<boolean>;
  toolVersionCancel(): Promise<void>;
  toolVersionsState(): Promise<ToolVersionsState>;
  toolVersionInstall(request: { id: string; confirm: true }): Promise<ToolVersionsState>;
  toolVersionSelect(request: { id: string }): Promise<Partial<ProjectConfig['toolchain']>>;
}
export interface ToolPackageResult {
  id: string;
  name: string;
  size: number;
  sha256: string;
  toolId: string;
  platform: string;
  arch: string;
}
