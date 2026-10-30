import type { AiAssistanceApi } from './ai';
import type { CollaborationApi } from './collaboration';
import type { WorkbenchApi } from './workbench';
import type { GitApi } from './git';
import type { ToolVersionsApi } from './tool-versions';
import type { HostWorkspaceApi } from './host-workspace';
import type { ProjectPackageApi } from './project-package';
import type { TerminalApi } from './terminal';
import type { LanguageApi } from './language';
import type { ComponentLibrariesApi } from './components';
import { APP_CLOSE_REQUEST_CHANNEL, type DesktopLifecycleApi } from './desktop-lifecycle';
import type { RuntimePluginsApi } from './plugins';
import { COLLABORATION_CHANNEL, UI_COMMAND_CHANNEL } from './contracts';

export function createWorkbenchBridge(
  call: (method: string, args: unknown[]) => Promise<unknown>,
  subscribe: <T>(channel: string, callback: (event: T) => void) => () => void,
): AiAssistanceApi &
  CollaborationApi &
  WorkbenchApi &
  GitApi &
  ToolVersionsApi &
  HostWorkspaceApi &
  ProjectPackageApi &
  LanguageApi &
  DesktopLifecycleApi &
  RuntimePluginsApi &
  ComponentLibrariesApi &
  TerminalApi {
  const invoke = call as <T>(method: string, args: unknown[]) => Promise<T>;
  return {
    componentsState: () => invoke('componentsState', []),
    componentsSearch: (query) => invoke('componentsSearch', [query]),
    componentsInstall: (request) => invoke('componentsInstall', [request]),
    componentsImport: (request) => invoke('componentsImport', [request]),
    componentsRemove: (request) => invoke('componentsRemove', [request]),
    desktopLifecycleState: () => invoke('desktopLifecycleState', []),
    desktopLifecycleConfigure: (request) => invoke('desktopLifecycleConfigure', [request]),
    desktopCloseReply: (request) => invoke('desktopCloseReply', [request]),
    onAppCloseRequest: (callback) => subscribe(APP_CLOSE_REQUEST_CHANNEL, callback),
    runtimePluginViewInfo: (id, viewId) => invoke('runtimePluginViewInfo', [id, viewId]),
    runtimePluginOpenView: (id, viewId) => invoke('runtimePluginOpenView', [id, viewId]),
    runtimePluginsState: () => invoke('runtimePluginsState', []),
    runtimePluginTrust: (input) => invoke('runtimePluginTrust', [input]),
    runtimePluginView: (id, kind) => invoke('runtimePluginView', [id, kind]),
    runtimePluginViewDocument: (id, kind) => invoke('runtimePluginViewDocument', [id, kind]),
    runtimePluginDebug: (id, method, args) => invoke('runtimePluginDebug', [id, method, args]),
    runtimePluginDevice: (id, method, args, confirm) =>
      invoke('runtimePluginDevice', [id, method, args, confirm]),
    runtimePluginContext: (id) => invoke('runtimePluginContext', [id]),
    runtimePluginConfigure: (id, value) => invoke('runtimePluginConfigure', [id, value]),
    languageIndex: () => invoke('languageIndex', []),
    gitStatus: () => invoke('gitStatus', []),
    gitDiff: (input) => invoke('gitDiff', [input]),
    gitAction: (input) => invoke('gitAction', [input]),
    toolVersionsState: () => invoke('toolVersionsState', []),
    toolVersionInstall: (input) => invoke('toolVersionInstall', [input]),
    toolVersionSelect: (input) => invoke('toolVersionSelect', [input]),
    hostBrowse: (path) => invoke('hostBrowse', path ? [path] : []),
    hostOpenProject: (path) => invoke('hostOpenProject', [path]),
    projectPackagePreview: () => invoke('projectPackagePreview', []),
    projectPackageExport: (input) => invoke('projectPackageExport', [input]),
    projectPackageSave: (id) => invoke('projectPackageSave', [id]),
    terminalState: (cursor) => invoke('terminalState', cursor ? [cursor] : []),
    terminalOpen: (size) => invoke('terminalOpen', size ? [size] : []),
    terminalWrite: (request) => invoke('terminalWrite', [request]),
    terminalResize: (request) => invoke('terminalResize', [request]),
    terminalClose: () => invoke('terminalClose', []),
    terminalRun: (input) => invoke('terminalRun', [input]),
    terminalStop: () => invoke('terminalStop', []),
    aiAssistanceState: () => invoke('aiAssistanceState', []),
    aiAssistanceConfigure: (config) => invoke('aiAssistanceConfigure', [config]),
    aiPredictionRequest: (context) => invoke('aiPredictionRequest', [context]),
    aiPredictionCancel: (request) => invoke('aiPredictionCancel', [request]),
    aiPredictionPoll: (request = {}) => invoke('aiPredictionPoll', [request]),
    aiPredictionSubmit: (request) => invoke('aiPredictionSubmit', [request]),
    aiPredictionRead: (request) => invoke('aiPredictionRead', [request]),
    collaborationState: () => invoke('collaborationState', []),
    collaborationOpen: (projectRoot, path) => invoke('collaborationOpen', [projectRoot, path]),
    collaborationPresence: (input) => invoke('collaborationPresence', [input]),
    collaborationEdit: (request) => invoke('collaborationEdit', [request]),
    collaborationUndo: (request) => invoke('collaborationUndo', [request]),
    collaborationSave: (request) => invoke('collaborationSave', [request]),
    collaborationResolve: (request) => invoke('collaborationResolve', [request]),
    collaborationLeave: (peerId) => invoke('collaborationLeave', [peerId]),
    onCollaboration: (callback) => subscribe(COLLABORATION_CHANNEL, callback),
    uiPublishState: (state) => invoke('uiPublishState', [state]),
    uiCommandReply: (reply) => invoke('uiCommandReply', [reply]),
    onUiCommand: (callback) => subscribe(UI_COMMAND_CHANNEL, callback),
  };
}
