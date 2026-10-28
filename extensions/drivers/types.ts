import type { DriverId } from '../../src/shared/contracts.js';

/** Vendor debug-probe facts; core owns extraction, detection and elevation. */
export interface DriverDefinition {
  readonly id: DriverId;
  readonly name: string;
  /** Archive file name inside the bundled driver root. */
  readonly archive: string;
  /** Signed INF files the installer must stage, in package order. */
  readonly infFiles: readonly string[];
  /** USB instance-id fragments covered by those INF files. */
  readonly deviceIds: readonly string[];
  /** Driver-store folder prefix that proves the package is staged. */
  readonly storeEntry: RegExp;
}
