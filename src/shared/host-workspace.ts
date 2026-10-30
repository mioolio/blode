export interface HostEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
}
export interface HostListing {
  path: string;
  parent: string | null;
  roots: string[];
  entries: HostEntry[];
  truncated: boolean;
}
export interface HostWorkspaceApi {
  hostBrowse(path?: string): Promise<HostListing>;
  vscodeOpen(request: VSCodeOpenRequest): Promise<VSCodeOpenResult>;
  hostOpenProject(path: string): Promise<boolean>;
}
import type { VSCodeOpenRequest, VSCodeOpenResult } from './vscode';
