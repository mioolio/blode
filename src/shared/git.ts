export type GitFileCode = 'M' | 'U' | 'A' | 'D' | 'R' | 'C' | 'T' | '!';
export interface GitFileStatus {
  /** Relative to the opened project, not necessarily the repository root. */
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  code: GitFileCode;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}
export interface GitStatus {
  mode?: 'isolated' | 'shared' | 'disabled';
  ownedHistory?: boolean;
  sharedAvailable?: boolean;
  available: boolean;
  repository: boolean;
  projectRoot: string;
  repositoryRoot: string;
  branch: string;
  detached: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  branches: string[];
  remotes: GitRemote[];
  identity: { name: string; email: string };
  /** Changes outside an opened subdirectory are not staged by this workbench. */
  outsideChanges: number;
  outsideStaged: number;
}
export type GitActionRequest =
  | { action: 'init' }
  | { action: 'setMode'; mode: 'isolated' | 'shared' | 'disabled'; confirm: true }
  | { action: 'removeRepository'; target: 'isolated' | 'shared'; repositoryRoot?: string; confirm: true }
  | { action: 'stage' | 'unstage'; paths: string[] }
  | { action: 'commit'; message: string; confirm: true }
  | { action: 'createBranch' | 'checkout'; branch: string }
  | { action: 'remoteSet'; name: string; url: string }
  | { action: 'remoteRemove'; name: string; confirm: true }
  | { action: 'configure'; name: string; email: string }
  | { action: 'fetch'; remote: string }
  | { action: 'pull' | 'push'; remote: string; branch?: string; confirm: true };
export interface GitActionResult {
  status: GitStatus;
  output: string;
}
export interface GitApi {
  gitStatus(): Promise<GitStatus>;
  gitDiff(request: { path: string; staged?: boolean }): Promise<string>;
  gitAction(request: GitActionRequest): Promise<GitActionResult>;
}
