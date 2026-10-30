import { BrowserWindow, type WebContents } from 'electron';
import type { RuntimeViewContribution } from '../shared/plugins';

/** Owns the extra windows declared by approved runtime packages. */
export class RuntimeWindows {
  private windows = new Map<
    string,
    { pluginId: string; kind: 'runtime' | 'extension'; window: BrowserWindow }
  >();
  private pending = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly options: {
      preload: string;
      rendererFile: string;
      rendererUrl?: string;
      background: () => string;
    },
  ) {}
  owner(contents: WebContents) {
    return [...this.windows.values()].find((value) => value.window.webContents === contents);
  }
  retainExtensions(enabled: ReadonlySet<string>) {
    for (const { kind, pluginId, window } of this.windows.values())
      if (kind === 'extension' && !enabled.has(pluginId) && !window.isDestroyed()) window.destroy();
  }
  publishExtensionEvent(channel: string, event: unknown) {
    for (const { kind, window } of this.windows.values()) {
      if (kind !== 'extension' || window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        const frame = window.webContents.mainFrame;
        if (frame && !frame.detached) frame.send(channel, event);
      } catch {
        /* A closing renderer no longer needs the update. */
      }
    }
  }
  async open(pluginId: string, view: RuntimeViewContribution, kind: 'runtime' | 'extension' = 'runtime') {
    if (this.closed) throw new Error('error.operationCancelled');
    const key = `${kind}/${pluginId}/${view.id}`;
    const existing = this.windows.get(key)?.window;
    if (this.pending.has(key)) return this.pending.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    if (this.windows.size >= 8) throw new Error('rpc.limitExceeded');
    const create = async () => {
      const window = new BrowserWindow({
        title: view.label,
        frame: false,
        width: view.width ?? 1000,
        height: view.height ?? 720,
        minWidth: 320,
        minHeight: 240,
        backgroundColor: this.options.background(),
        show: false,
        webPreferences: {
          additionalArguments: ['--blode-frameless'],
          preload: this.options.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      this.windows.set(key, { pluginId, kind, window });
      window.removeMenu();
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.once('closed', () => {
        if (this.windows.get(key)?.window === window) this.windows.delete(key);
      });
      const hash = `/${kind === 'runtime' ? 'runtime-view' : 'extension-view'}/${encodeURIComponent(pluginId)}/${encodeURIComponent(view.id)}`;
      try {
        if (this.options.rendererUrl) {
          const url = new URL(this.options.rendererUrl);
          url.hash = hash;
          await window.loadURL(url.href);
        } else await window.loadFile(this.options.rendererFile, { hash });
        if (this.closed || window.isDestroyed()) throw new Error('error.operationCancelled');
        window.show();
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    };
    const pending = create();
    this.pending.set(key, pending);
    try {
      await pending;
    } finally {
      this.pending.delete(key);
    }
  }
  close() {
    this.closed = true;
    for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.destroy();
    this.windows.clear();
  }
}
