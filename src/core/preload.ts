import { contextBridge, ipcRenderer } from 'electron';
import {
  DRAFTS_CHANNEL,
  EVENT_CHANNEL,
  IPC_CHANNEL,
  type DesktopApi,
  type LogEvent,
} from '../shared/contracts';

// Only this typed, explicit surface crosses the sandbox boundary.
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNEL, method, args);
const bridge: DesktopApi = {
  listRecentProjects: () => call('listRecentProjects'),
  openRecentProject: (path) => call('openRecentProject', path),
  removeRecentProject: (path) => call('removeRecentProject', path),
  closeProject: () => call('closeProject'),
  firmwareExport: (format) => call('firmwareExport', format),
  firmwareChoose: () => call('firmwareChoose'),
  firmwareFlash: (request) => call('firmwareFlash', request),
  openDebugger: () => call('openDebugger'),
  debuggerState: () => call('debuggerState'),
  debuggerSymbols: () => call('debuggerSymbols'),
  debuggerConnect: (config) => call('debuggerConnect', config),
  debuggerAction: (action) => call('debuggerAction', action),
  debuggerBreakpoint: (location, removeId) => call('debuggerBreakpoint', location, removeId),
  debuggerMemory: (address, length) => call('debuggerMemory', address, length),
  debuggerInstallTools: () => call('debuggerInstallTools'),
  debuggerChooseGdb: () => call('debuggerChooseGdb'),
  debuggerStorage: () => call('debuggerStorage'),
  exportProbeLog: (content) => call('exportProbeLog', content),
  getState: () => call('getState'),
  listPorts: () => call('listPorts'),
  listDebugProbes: () => call('listDebugProbes'),
  scanDevices: () => call('scanDevices'),
  saveFile: (path, content) => call('saveFile', path, content),
  createFile: (path) => call('createFile', path),
  createDirectory: (path) => call('createDirectory', path),
  renameEntry: (from, to) => call('renameEntry', from, to),
  deleteEntry: (path) => call('deleteEntry', path),
  saveConfig: (config) => call('saveConfig', config),
  setBuildEntry: (path) => call('setBuildEntry', path),
  build: () => call('build'),
  flash: () => call('flash'),
  probe: (port, config) => call('probe', port, config),
  installToolchain: () => call('installToolchain'),
  installDriver: (id) => call('installDriver', id),
  refreshDrivers: () => call('refreshDrivers'),
  serialOpen: (port, baudRate, options) => call('serialOpen', port, baudRate, options),
  serialClose: () => call('serialClose'),
  serialWrite: (data, encoding) => call('serialWrite', data, encoding),
  selectProject: () => call('selectProject'),
  selectProjectMarker: () => call('selectProjectMarker'),
  reopenProject: () => call('reopenProject'),
  revealEntry: (path) => call('revealEntry', path),
  publishDrafts: (drafts) => {
    void call('publishDrafts', drafts).catch(() => {});
  },
  onDrafts: (callback) => {
    const handler = (_: unknown, drafts: Record<string, string>) => callback(drafts);
    ipcRenderer.on(DRAFTS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DRAFTS_CHANNEL, handler);
  },
  onEvent: (callback) => {
    const handler = (_: unknown, event: LogEvent) => callback(event);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, handler);
    };
  },
  windowAction: (action) => {
    void call('windowAction', action);
  },
};
contextBridge.exposeInMainWorld('blode', bridge);
// Describe the window that actually exists, rather than assuming HMR restarted Electron.
contextBridge.exposeInMainWorld('__blodeFrameless', process.argv.includes('--blode-frameless'));
