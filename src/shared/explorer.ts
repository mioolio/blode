/** Project-resource tree state persisted inside the project's private `.blode` folder. */
export interface ExplorerState {
  version: 1;
  /** Project-relative directories whose children are hidden. */
  collapsed: string[];
  rootCollapsed: boolean;
}
export interface ExplorerStateSaveRequest {
  expectedProjectRoot: string;
  state: ExplorerState;
}
export interface ExplorerStateApi {
  explorerState(): Promise<ExplorerState>;
  explorerStateSave(request: ExplorerStateSaveRequest): Promise<void>;
}
