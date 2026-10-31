export type ComponentKind = 'arduino' | 'c';

export interface ComponentLibrary {
  id: string;
  name: string;
  version?: string;
  kind: ComponentKind;
  /** Project-relative managed directory. */
  path: string;
  source: { type: 'directory' | 'archive' | 'arduino'; url?: string };
  /** Project-relative include directories and source files. */
  includes: string[];
  sources: string[];
  /** Library names and Arduino version constraints, as declared in depends. */
  dependencies: string[];
}

export interface ComponentProvidedLibrary {
  name: string;
  version?: string;
  path: string;
  kind: 'core';
}

export interface ComponentLibrariesState {
  projectRoot: string;
  manifestPath: string;
  components: ComponentLibrary[];
  provided: ComponentProvidedLibrary[];
}

export interface ComponentCatalogEntry {
  name: string;
  author?: string;
  description?: string;
  versions: string[];
  latestVersion: string;
  url?: string;
  dependencies?: string[];
  dependenciesByVersion?: Record<string, string[]>;
}

export interface ComponentSearchResult {
  query: string;
  entries: ComponentCatalogEntry[];
  truncated: boolean;
}

export interface ComponentInstallRequest {
  allowUntrusted?: true;
  name: string;
  version: string;
  expectedProjectRoot: string;
  confirm: true;
}

export interface ComponentImportRequest {
  approval?: import('./package-signing').PackageApproval;
  path: string;
  kind: 'directory' | 'archive';
  expectedProjectRoot: string;
  confirm: true;
}

export interface ComponentRemoveRequest {
  id: string;
  expectedProjectRoot: string;
  confirm: true;
}
export interface ComponentExportRequest {
  expectedProjectRoot: string;
  ids?: string[];
  confirm: true;
}
export interface ComponentPackageResult {
  id: string;
  name: string;
  size: number;
  sha256: string;
  componentCount: number;
  dependencies: string[];
}

/** File hashes protect edited or externally replaced libraries from removal. */
export interface ManagedComponentLibrary extends ComponentLibrary {
  integrity: Record<string, string>;
}

export interface ComponentManifest {
  version: 1;
  components: ManagedComponentLibrary[];
}

export interface ComponentLibrariesApi {
  componentsExport(request: ComponentExportRequest): Promise<ComponentPackageResult>;
  componentsPackageSave(id: string): Promise<boolean>;
  componentsState(): Promise<ComponentLibrariesState>;
  componentsSearch(query: string): Promise<ComponentSearchResult>;
  componentsInstall(request: ComponentInstallRequest): Promise<ComponentLibrariesState>;
  componentsImport(request: ComponentImportRequest): Promise<ComponentLibrariesState>;
  componentsRemove(request: ComponentRemoveRequest): Promise<ComponentLibrariesState>;
}
