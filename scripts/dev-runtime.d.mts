export interface ProcessInventoryEntry {
  ProcessId: number;
  ParentProcessId: number;
  ExecutablePath: string | null;
  CommandLine: string | null;
}
export interface OwnedProcess {
  pid: number;
  parentPid: number;
}
export interface DevRuntimeOptions {
  platform?: NodeJS.Platform;
  execFile?: (
    command: string,
    args: string[],
    options: { windowsHide?: boolean; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout?: string; stderr?: string }>;
  inventory?: ProcessInventoryEntry[] | (() => Promise<ProcessInventoryEntry[]>);
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  stopProcessTree?: (pid: number, options?: DevRuntimeOptions) => Promise<boolean>;
}
export function hasFatalStartupError(log: string): boolean;
export function hasReadyWindow(log: string): boolean;
export interface DevelopmentSandboxOptions {
  workspaceRoot: string;
  electronExecutable: string;
  electronVersion: string;
  profile: string;
  platform?: NodeJS.Platform;
  override?: string;
}
export interface DevelopmentSandboxSelection {
  mode: 'sandbox' | 'no-sandbox';
  canRetrySandbox: boolean;
  source: 'default' | 'verified' | 'required' | 'disabled';
}
export function resolveDevelopmentSandbox(
  options: DevelopmentSandboxOptions,
): Promise<DevelopmentSandboxSelection>;
export function rememberSandboxCompatibility(
  options: DevelopmentSandboxOptions,
  evidence: {
    failedAttempt: { code: number | null; timedOut: boolean; log: string };
    recoveredLog: string;
    sandboxDisabled: boolean;
    /** True for the launcher's additional software-rendering recovery attempt. */
    softwareRendering?: boolean;
  },
): Promise<boolean>;
export function classifyElectronExit(
  result: { code: number | null; timedOut: boolean; log: string },
  retries?: { sandbox?: boolean; software?: boolean },
): { retry: 'sandbox' | 'software' | null; failed: boolean; exitCode: number };
export function stopProcessTree(pid: number, options?: DevRuntimeOptions): Promise<boolean>;
export function findStaleElectronProcesses(
  electronExecutable: string,
  profile: string,
  options?: DevRuntimeOptions,
): Promise<OwnedProcess[]>;
export function recoverStaleElectron(
  electronExecutable: string,
  profile: string,
  options?: DevRuntimeOptions,
): Promise<number>;
export function findStaleVite(
  viteScript: string,
  nodeExecutable: string,
  options?: DevRuntimeOptions,
): Promise<OwnedProcess[]>;
export function recoverStaleVite(
  viteScript: string,
  nodeExecutable: string,
  options?: DevRuntimeOptions,
): Promise<number>;
export function recoverStaleDevProcesses(
  electronExecutable: string,
  profile: string,
  viteScript: string,
  nodeExecutable: string,
  options?: DevRuntimeOptions,
): Promise<number>;
