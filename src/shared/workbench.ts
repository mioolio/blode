export type UiAction =
  | 'home'
  | 'project'
  | 'view'
  | 'openFile'
  | 'closeFile'
  | 'pinFile'
  | 'preferences'
  | 'save'
  | 'console'
  | 'consolePanel'
  | 'devicePanel'
  | 'editor'
  | 'splitEditor'
  | 'language'
  | 'syncDrafts'
  | 'clearLogs';
export interface UiCommand {
  action: UiAction;
  target?: string;
  path?: string;
  view?: 'code' | 'layout' | 'ai';
  tab?: 'output' | 'serial' | 'problems' | 'warnings' | 'terminal';
  visible?: boolean;
  language?: 'zh-CN' | 'en';
  command?: 'undo' | 'redo' | 'find' | 'format' | 'gotoLine' | 'selectAll';
}
export interface UiRequest extends UiCommand {
  id: string;
  target: string;
}
export interface UiState {
  clientId: string;
  browser: boolean;
  projectRoot: string;
  activePath: string;
  openFiles: string[];
  view: string;
  home: boolean;
  dirtyFiles: string[];
  busy: string;
  consolePanelVisible: boolean;
  devicePanelVisible: boolean;
}
export interface UiCommandReply {
  id: string;
  clientId: string;
  error?: string;
}
export interface WorkbenchApi {
  uiPublishState(state: UiState): Promise<void>;
  uiCommandReply(reply: UiCommandReply): Promise<void>;
  onUiCommand(callback: (request: UiRequest) => void): () => void;
}
