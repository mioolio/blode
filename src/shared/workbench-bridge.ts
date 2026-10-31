import type { AiAssistanceApi } from './ai';
import type { ModelServiceApi } from './model-service';
import type { CollaborationApi } from './collaboration';
import type { WorkbenchApi } from './workbench';
import type { GitApi } from './git';
import type { ToolVersionsApi } from './tool-versions';
import type { HostWorkspaceApi } from './host-workspace';
import type { ProjectPackageApi } from './project-package';
import type { TerminalApi } from './terminal';
import type { LanguageApi } from './language';
import type { ClangdApi, ClangdState } from './clangd';
import type { ExplorerStateApi } from './explorer';
import type { GeneralExtensionsApi } from './general-extensions';
import type { ComponentLibrariesApi } from './components';
import { APP_CLOSE_REQUEST_CHANNEL, type DesktopLifecycleApi } from './desktop-lifecycle';
import type { RuntimePluginsApi } from './plugins';
import { COLLABORATION_CHANNEL, UI_COMMAND_CHANNEL } from './contracts';

export function createWorkbenchBridge(
  call: (method: string, args: unknown[]) => Promise<unknown>,
  subscribe: <T>(channel: string, callback: (event: T) => void) => () => void,
): AiAssistanceApi &
  GeneralExtensionsApi &
  ModelServiceApi &
  CollaborationApi &
  WorkbenchApi &
  GitApi &
  ToolVersionsApi &
  HostWorkspaceApi &
  ProjectPackageApi &
  LanguageApi &
  ClangdApi &
  ExplorerStateApi &
  DesktopLifecycleApi &
  RuntimePluginsApi &
  ComponentLibrariesApi &
  TerminalApi {
  const invoke = call as <T>(method: string, args: unknown[]) => Promise<T>;
  return {
    generalExtensionState: () => invoke('generalExtensionState', []),
    generalExtensionReview: (request) => invoke('generalExtensionReview', [request]),
    generalExtensionInstall: (request) => invoke('generalExtensionInstall', [request]),
    generalExtensionEnable: (request) => invoke('generalExtensionEnable', [request]),
    generalExtensionDisable: (request) => invoke('generalExtensionDisable', [request]),
    generalExtensionRemove: (request) => invoke('generalExtensionRemove', [request]),
    generalExtensionConfigure: (request) => invoke('generalExtensionConfigure', [request]),
    generalExtensionExport: (request) => invoke('generalExtensionExport', [request]),
    generalExtensionPackageSave: (id) => invoke('generalExtensionPackageSave', [id]),
    generalExtensionViewDocument: (request) => invoke('generalExtensionViewDocument', [request]),
    generalExtensionViewUrl: (request) => invoke('generalExtensionViewUrl', [request]),
    generalExtensionOpenView: (request) => invoke('generalExtensionOpenView', [request]),
    generalExtensionContext: (request) => invoke('generalExtensionContext', [request]),
    componentsState: () => invoke('componentsState', []),
    componentsExport: (request) => invoke('componentsExport', [request]),
    componentsPackageSave: (id) => invoke('componentsPackageSave', [id]),
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
    devicePackagesState: () => invoke('devicePackagesState', []),
    devicePackageExport: (request) => invoke('devicePackageExport', [request]),
    devicePackageSave: (id) => invoke('devicePackageSave', [id]),
    devicePackageReview: (request) => invoke('devicePackageReview', [request]),
    devicePackageInstall: (request) => invoke('devicePackageInstall', [request]),
    runtimePluginTrust: (input) => invoke('runtimePluginTrust', [input]),
    runtimePluginView: (id, kind) => invoke('runtimePluginView', [id, kind]),
    runtimePluginViewDocument: (id, kind) => invoke('runtimePluginViewDocument', [id, kind]),
    runtimePluginDebug: (id, method, args) => invoke('runtimePluginDebug', [id, method, args]),
    runtimePluginDevice: (id, method, args, confirm) =>
      invoke('runtimePluginDevice', [id, method, args, confirm]),
    runtimePluginContext: (id) => invoke('runtimePluginContext', [id]),
    runtimePluginConfigure: (id, value) => invoke('runtimePluginConfigure', [id, value]),
    languageIndex: () => invoke('languageIndex', []),
    languageLspRequest: (request) =>
      invoke('languageLspRequest', [request]) as Promise<import('./lsp').LspResponse>,
    languageLspNotify: (request) => invoke('languageLspNotify', [request]) as Promise<void>,
    languageClangdState: () => invoke<ClangdState>('languageClangdState', []),
    languageClangdRequest: (request) => invoke('languageClangdRequest', [request]),
    languageClangdNotify: (request) => invoke('languageClangdNotify', [request]) as Promise<void>,
    languageClangdDiagnostics: (request) =>
      invoke('languageClangdDiagnostics', [request]) as ReturnType<ClangdApi['languageClangdDiagnostics']>,
    languageNavigate: (request) => invoke('languageNavigate', [request]),
    languageCancel: (request) => invoke('languageCancel', [request]),
    languageOpenExternal: (request) => invoke('languageOpenExternal', [request]),
    explorerState: () => invoke('explorerState', []),
    explorerStateSave: (request) => invoke('explorerStateSave', [request]) as Promise<void>,
    gitStatus: () => invoke('gitStatus', []),
    gitDiff: (input) => invoke('gitDiff', [input]),
    gitAction: (input) => invoke('gitAction', [input]),
    toolVersionsState: () => invoke('toolVersionsState', []),
    toolVersionDownload: (request) => invoke('toolVersionDownload', [request]),
    toolVersionExport: (request) => invoke('toolVersionExport', [request]),
    toolVersionImport: (request) => invoke('toolVersionImport', [request]),
    toolVersionPackageSave: (id) => invoke('toolVersionPackageSave', [id]),
    toolVersionCancel: () => invoke('toolVersionCancel', []),
    toolVersionInstall: (input) => invoke('toolVersionInstall', [input]),
    toolVersionSelect: (input) => invoke('toolVersionSelect', [input]),
    hostBrowse: (path) => invoke('hostBrowse', path ? [path] : []),
    vscodeOpen: (request) => invoke('vscodeOpen', [request]),
    hostOpenProject: (path) => invoke('hostOpenProject', [path]),
    projectPackagePreview: () => invoke('projectPackagePreview', []),
    projectPackageExport: (input) => invoke('projectPackageExport', [input]),
    projectPackageSave: (id) => invoke('projectPackageSave', [id]),
    terminalSessions: () => invoke('terminalSessions', []),
    terminalState: (cursor) => invoke('terminalState', cursor ? [cursor] : []),
    terminalOpen: (size) => invoke('terminalOpen', size ? [size] : []),
    terminalWrite: (request) => invoke('terminalWrite', [request]),
    terminalResize: (request) => invoke('terminalResize', [request]),
    terminalClose: (target) => invoke('terminalClose', target ? [target] : []),
    terminalRun: (input) => invoke('terminalRun', [input]),
    terminalStop: (target) => invoke('terminalStop', target ? [target] : []),
    aiAssistanceState: () => invoke('aiAssistanceState', []),
    modelServiceState: () => invoke('modelServiceState', []),
    modelServiceConfigure: (request) => invoke('modelServiceConfigure', [request]),
    modelServiceTest: () => invoke('modelServiceTest', []),
    aiChatStart: (request) => invoke('aiChatStart', [request]),
    aiChatState: (request) => invoke('aiChatState', [request]),
    aiChatCancel: (request) => invoke('aiChatCancel', [request]),
    aiAssistanceConfigure: (config) => invoke('aiAssistanceConfigure', [config]),
    aiPredictionRequest: (context) => invoke('aiPredictionRequest', [context]),
    aiPredictionCancel: (request) => invoke('aiPredictionCancel', [request]),
    aiPredictionPoll: (request = {}) => invoke('aiPredictionPoll', [request]),
    aiPredictionSubmit: (request) => invoke('aiPredictionSubmit', [request]),
    aiPredictionRead: (request) => invoke('aiPredictionRead', [request]),
    collaborationState: () => invoke('collaborationState', []),
    collaborationSurfaceBootstrap: (request) => invoke('collaborationSurfaceBootstrap', [request]),
    collaborationTabClose: (request) => invoke('collaborationTabClose', [request]),
    collaborationTabCloseVote: (request) => invoke('collaborationTabCloseVote', [request]),
    collaborationSurfaceUpdate: (request) => invoke('collaborationSurfaceUpdate', [request]),
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
