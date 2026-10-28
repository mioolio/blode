export interface RuntimeIntegrityReport {
  processIntegrity: number | null;
  files: { path: string; before: number; after: number; repaired: boolean }[];
}
export function ensureWindowsRuntimeIntegrity(
  executables?: readonly string[],
  options?: { repair?: boolean },
): Promise<RuntimeIntegrityReport>;
