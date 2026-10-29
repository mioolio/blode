export interface RuntimeIntegrityReport {
  processIntegrity: number | null;
  files: { path: string; before: number; after: number; repaired: boolean }[];
}
/** Fixed startup children; does not enumerate compiler or SDK trees. */
export function developmentRuntimeExecutables(electronExecutable: string, root?: string): Promise<string[]>;
export function ensureWindowsRuntimeIntegrity(
  executables?: readonly string[],
  options?: { repair?: boolean },
): Promise<RuntimeIntegrityReport>;
