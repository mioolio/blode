import type { AppState, DesktopApi } from '../shared/contracts';
import { probeLogFilename, validateProbeLog } from '../shared/probe-log';
import { createWorkbenchBridge } from '../shared/workbench-bridge';
import { pickHostPath } from './workspace/hostPicker';

const scope = window as Window & { blode?: DesktopApi; __blodeWeb?: boolean };

if (!scope.blode) {
  scope.__blodeWeb = true;
  const apiBase = window.location.port === '5173' ? `http://${window.location.hostname}:47821` : '';
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  // One transport owner per page, independent of shared localStorage user identity.
  const client = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const response = await fetch(`${apiBase}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-blode-token': token } : {}),
        'x-blode-client': client,
      },
      body: JSON.stringify({ method, args }),
      keepalive: method === 'collaborationLeave',
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
    return body;
  };

  let stream: EventSource | undefined;
  const listeners = new Map<string, Set<(event: any) => void>>();
  const subscribe = <T>(channel: string, callback: (event: T) => void) => {
    if (!stream) {
      stream = new EventSource(
        `${apiBase}/events?client=${client}${token ? `&token=${encodeURIComponent(token)}` : ''}`,
      );
      stream.addEventListener('open', () => window.dispatchEvent(new Event('blode:collaboration-reconnect')));
    }
    if (!listeners.has(channel)) {
      const callbacks = new Set<(event: any) => void>();
      listeners.set(channel, callbacks);
      stream.addEventListener(channel, (event) => {
        try {
          const value = JSON.parse((event as MessageEvent).data);
          for (const listener of callbacks) listener(value);
        } catch {
          /* Ignore malformed frames. */
        }
      });
    }
    const callbacks = listeners.get(channel)!;
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
      if (![...listeners.values()].some((values) => values.size)) {
        stream?.close();
        stream = undefined;
        listeners.clear();
      }
    };
  };
  const bridge: DesktopApi = {
    ...createWorkbenchBridge(call, subscribe),
    listRecentProjects: () => call('listRecentProjects', []) as ReturnType<DesktopApi['listRecentProjects']>,
    openRecentProject: (root) =>
      call('openRecentProject', [root]) as ReturnType<DesktopApi['openRecentProject']>,
    removeRecentProject: (root) => call('removeRecentProject', [root]) as Promise<void>,
    closeProject: () => call('closeProject', []) as Promise<void>,
    projectPackageSave: async (id) => {
      const response = await fetch(`${apiBase}/project/package/${encodeURIComponent(id)}`, {
        headers: token ? { 'x-blode-token': token } : {},
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      const name = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '');
      anchor.download = name ? decodeURIComponent(name[1]) : 'project.zip';
      document.body.append(anchor);
      try {
        anchor.click();
        return true;
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },
    firmwareExport: async (format) => {
      const destination = await pickHostPath({
        kind: 'save',
        defaultName: `firmware.${format}`,
        extensions: [format],
      });
      if (!destination) return { status: 'cancelled' };
      return call('firmwareExportPath', [
        { format, path: destination, confirmOverwrite: true },
      ]) as ReturnType<DesktopApi['firmwareExport']>;
    },
    firmwareChoose: async () => {
      const file = await pickHostPath({
        kind: 'file',
        extensions: ['bin', 'hex', 'ihex', 'srec', 's19', 's28', 's37', 'mot'],
      });
      return file ? (call('firmwareChoosePath', [file]) as ReturnType<DesktopApi['firmwareChoose']>) : null;
    },
    firmwareFlash: (request) => call('firmwareFlash', [request]) as Promise<void>,
    openDebugger: async () => {
      const url = new URL(window.location.href);
      url.hash = '/hardware-debugger';
      // Open synchronously from the menu click, before any RPC awaits lose the user gesture.
      const tab = window.open(url.href, '_blank');
      if (!tab) throw new Error('error.debuggerPopupBlocked');
      tab.opener = null;
    },
    debuggerState: () => call('debuggerState', []) as ReturnType<DesktopApi['debuggerState']>,
    debuggerSymbols: async () => {
      const file = await pickHostPath({ kind: 'file', extensions: ['elf', 'axf'] });
      return file ? (call('debuggerSymbolsPath', [file]) as Promise<string>) : null;
    },
    debuggerConnect: (config) => call('debuggerConnect', [config]) as Promise<void>,
    debuggerAction: (action) => call('debuggerAction', [action]) as Promise<void>,
    debuggerBreakpoint: (location, id) =>
      call('debuggerBreakpoint', id === undefined ? [location] : [location, id]) as Promise<void>,
    debuggerMemory: (address, length) => call('debuggerMemory', [address, length]) as Promise<string>,
    debuggerInstallTools: () => call('debuggerInstallTools', []) as Promise<void>,
    debuggerChooseGdb: async () => {
      const file = await pickHostPath({ kind: 'file' });
      return file ? (call('debuggerChooseGdbPath', [file]) as Promise<boolean>) : false;
    },
    debuggerStorage: () => call('debuggerStorage', []) as ReturnType<DesktopApi['debuggerStorage']>,
    exportProbeLog: async (content) => {
      validateProbeLog(content);
      const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = probeLogFilename();
      document.body.append(anchor);
      try {
        anchor.click();
        return 'download-started';
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },
    getState: () => call('getState', []) as ReturnType<DesktopApi['getState']>,
    listPorts: () => call('listPorts', []) as ReturnType<DesktopApi['listPorts']>,
    listDebugProbes: () => call('listDebugProbes', []) as ReturnType<DesktopApi['listDebugProbes']>,
    scanDevices: () => call('scanDevices', []) as ReturnType<DesktopApi['scanDevices']>,
    saveFile: (path, content) => call('saveFile', [path, content]) as Promise<void>,
    createFile: (path) => call('createFile', [path]) as Promise<void>,
    createDirectory: (path) => call('createDirectory', [path]) as Promise<void>,
    renameEntry: (from, to) => call('renameEntry', [from, to]) as Promise<void>,
    deleteEntry: (path) => call('deleteEntry', [path]) as Promise<void>,
    saveConfig: (config) => call('saveConfig', [config]) as Promise<void>,
    setBuildEntry: (path) => call('setBuildEntry', [path]) as Promise<void>,
    build: () => call('build', []) as ReturnType<DesktopApi['build']>,
    flash: () => call('flash', []) as Promise<void>,
    probe: (port, config) => call('probe', [port, config]) as Promise<string>,
    installToolchain: () => call('installToolchain', []) as ReturnType<DesktopApi['installToolchain']>,
    // Elevated, machine-wide driver setup stays a native desktop action.
    installDriver: async () => {
      throw new Error('error.driverDesktopOnly');
    },
    refreshDrivers: async () => (await (call('getState', []) as Promise<AppState>)).drivers,
    serialOpen: (port, baudRate, options) => call('serialOpen', [port, baudRate, options]) as Promise<void>,
    serialClose: () => call('serialClose', []) as Promise<void>,
    serialWrite: (data, encoding) => call('serialWrite', [data, encoding]) as Promise<void>,
    selectProject: async () => {
      const directory = await pickHostPath({ kind: 'directory' });
      return directory ? (call('hostOpenProject', [directory]) as Promise<boolean>) : false;
    },
    selectProjectMarker: async () => {
      const marker = await pickHostPath({ kind: 'file' });
      if (!marker) return false;
      if (marker.split(/[\\/]/).pop()?.toLowerCase() !== 'be') throw new Error('error.invalidProjectMarker');
      return call('hostOpenProject', [marker.replace(/[\\/][^\\/]+$/, '')]) as Promise<boolean>;
    },
    reopenProject: async () => {
      const recent = await bridge.listRecentProjects();
      return recent[0] ? bridge.openRecentProject(recent[0].path) : { status: 'none' };
    },
    revealEntry: async () => {},
    publishDrafts: () => {},
    onDrafts: (callback) => subscribe('drafts', callback),
    onEvent: (callback) => subscribe('message', callback),
    windowAction: () => {},
  };
  scope.blode = bridge;
}
