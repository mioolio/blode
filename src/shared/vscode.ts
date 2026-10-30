export interface VSCodeOpenRequest {
  expectedProjectRoot: string;
  /** Project-relative file to reveal after opening the generated workspace. */
  path?: string;
  line?: number;
  column?: number;
  confirm: true;
}

export interface VSCodeOpenResult {
  workspaceFile: string;
  executable: string;
}
