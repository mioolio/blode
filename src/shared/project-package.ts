export interface PackageDependency {
  source: string;
  destination: string;
  external: boolean;
  size: number;
}
export interface PackageWarning {
  file: string;
  reference: string;
  reason: string;
}
export interface ProjectPackagePlan {
  projectRoot: string;
  name: string;
  files: PackageDependency[];
  warnings: PackageWarning[];
  externalCount: number;
  bytes: number;
  toolRequirements: string[];
}
export interface ProjectPackageResult {
  id: string;
  name: string;
  size: number;
  warnings: PackageWarning[];
}
export interface ProjectPackageApi {
  projectPackagePreview(): Promise<ProjectPackagePlan>;
  projectPackageExport(options: {
    expectedProjectRoot?: string;
    confirmExternal?: true;
    allowIncomplete?: true;
  }): Promise<ProjectPackageResult>;
  projectPackageSave(id: string): Promise<boolean>;
}
