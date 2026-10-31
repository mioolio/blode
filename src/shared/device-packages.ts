export interface DevicePackageInfo {
  id: string;
  name: string;
  version: string;
  source: 'builtin' | 'plugin';
  directory: string;
  exportId: string;
  support: string[];
  transport: string;
}
export interface DevicePackagesState {
  packages: DevicePackageInfo[];
}
export interface DevicePackageExport {
  id: string;
  name: string;
  size: number;
  sha256: string;
}
export interface DevicePackageReview {
  verification?: import('./package-signing').PackageVerification;
  ticket: string;
  fingerprint: string;
  id: string;
  name: string;
  version: string;
  support: string[];
  fileCount: number;
  bytes: number;
}
export interface DevicePackagesApi {
  devicePackagesVerify(
    ids: string[],
  ): Promise<{ id: string; health: import('./package-health').PackageHealth }[]>;
  devicePackageOpenLocation(id: string): Promise<void>;
  devicePackagesState(): Promise<DevicePackagesState>;
  devicePackageExport(request: { id: string; confirm: true }): Promise<DevicePackageExport>;
  devicePackageSave(id: string): Promise<boolean>;
  devicePackageReview(request: { path: string }): Promise<DevicePackageReview>;
  devicePackageInstall(request: {
    approval?: import('./package-signing').PackageApproval;
    ticket: string;
    fingerprint: string;
    confirm: true;
  }): Promise<DevicePackagesState>;
}
