import type { DesktopApi } from '../shared/contracts';

const scope = window as Window & { blode?: DesktopApi; __blodeWeb?: boolean };

if (!scope.blode) {
  scope.__blodeWeb = true;
  const apiBase = window.location.port === '5173' ? 'http://127.0.0.1:47821' : '';
  const token = new URLSearchParams(window.location.search).get('token') ?? '';

  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const response = await fetch(`${apiBase}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-blode-token': token } : {}),
      },
      body: JSON.stringify({ method, args }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
    return body;
  };

  const bridge: DesktopApi = {
    getState: () => call('getState', []) as ReturnType<DesktopApi['getState']>,
    listPorts: () => call('listPorts', []) as ReturnType<DesktopApi['listPorts']>,
    saveFile: (path, content) => call('saveFile', [path, content]) as Promise<void>,
    createFile: (path) => call('createFile', [path]) as Promise<void>,
    createDirectory: (path) => call('createDirectory', [path]) as Promise<void>,
    renameEntry: (from, to) => call('renameEntry', [from, to]) as Promise<void>,
    deleteEntry: (path) => call('deleteEntry', [path]) as Promise<void>,
    saveConfig: (config) => call('saveConfig', [config]) as Promise<void>,
    build: () => call('build', []) as ReturnType<DesktopApi['build']>,
    flash: () => call('flash', []) as Promise<void>,
    probe: (port) => call('probe', [port]) as Promise<string>,
    installToolchain: () => call('installToolchain', []) as ReturnType<DesktopApi['installToolchain']>,
    serialOpen: (port, baudRate) => call('serialOpen', [port, baudRate]) as Promise<void>,
    serialClose: () => call('serialClose', []) as Promise<void>,
    serialWrite: (data) => call('serialWrite', [data]) as Promise<void>,
    // Native project picker and shell reveal remain desktop-only actions.
    selectProject: async () => false,
    selectProjectMarker: async () => false,
    revealEntry: async () => {},
    publishDrafts: () => {},
    onDrafts: (callback) => {
      const source = new EventSource(
        `${apiBase}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      );
      const handler = (event: MessageEvent) => {
        try {
          callback(JSON.parse(event.data));
        } catch {
          /* Ignore malformed draft frames. */
        }
      };
      source.addEventListener('drafts', handler as EventListener);
      return () => source.close();
    },
    onEvent: (callback) => {
      const source = new EventSource(
        `${apiBase}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      );
      source.onmessage = (event) => {
        try {
          callback(JSON.parse(event.data));
        } catch {
          /* Ignore malformed frames and keep the stream alive. */
        }
      };
      return () => source.close();
    },
    windowAction: () => {},
  };
  scope.blode = bridge;
}
