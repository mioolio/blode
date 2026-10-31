import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  APP_CLOSE_REQUEST_CHANNEL,
  type AppCloseDecision,
  type AppCloseRequest,
  type DesktopLifecycleState,
} from '../shared/desktop-lifecycle';
import { createTrayIcon } from './tray-icon';
import { sendToRenderer } from './renderer-delivery';

export interface TraySpecification {
  png: Buffer;
  locale: 'zh-CN' | 'en';
  show: () => void;
  quit: () => void;
}
export interface LifecycleTray {
  destroy(): void;
}
export interface DesktopLifecycleOptions {
  window: Pick<
    BrowserWindow,
    'on' | 'removeListener' | 'isDestroyed' | 'show' | 'hide' | 'focus' | 'webContents'
  > &
    Partial<Pick<BrowserWindow, 'isMinimized' | 'restore'>>;
  dataRoot: string;
  rendererReady: () => boolean;
  sharedDirty: () => Promise<boolean>;
  prepareShutdown: (decision: 'clean' | 'saved' | 'discard') => Promise<void>;
  cancelShutdown: () => Promise<void>;
  exit: () => Promise<void> | void;
  createTray?: (specification: TraySpecification) => LifecycleTray | Promise<LifecycleTray>;
  requestTimeoutMs?: number;
  rendererCommit?: boolean;
}
async function nativeTray(spec: TraySpecification): Promise<LifecycleTray> {
  const electron = await import('electron');
  const { Tray, Menu, nativeImage } = (
    electron.Tray ? electron : (electron as any).default
  ) as typeof electron;
  const tray = new Tray(nativeImage.createFromBuffer(spec.png));
  try {
    tray.setToolTip('Blode Studio');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: spec.locale === 'en' ? 'Show Blode Studio' : '显示 Blode Studio', click: spec.show },
        { type: 'separator' },
        { label: spec.locale === 'en' ? 'Quit' : '退出', click: spec.quit },
      ]),
    );
    tray.on('double-click', spec.show);
    tray.on('click', spec.show);
    return tray;
  } catch (error) {
    tray.destroy();
    throw error;
  }
}

/** Window close, application quit and tray quit all share one save decision. */
export class DesktopLifecycle {
  private preferences: DesktopLifecycleState = {
    closeToTray: true,
    locale: 'zh-CN',
    available: true,
    quitting: false,
  };
  private tray?: LifecycleTray;
  private disposed = false;
  private waiting?: { request: AppCloseRequest; resolve: () => void; timer: ReturnType<typeof setTimeout> };
  private quit?: Promise<void>;
  private replyWork?: Promise<void>;
  private configureWork: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly lifecycleId = randomUUID();
  private commit?: {
    id: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(private readonly options: DesktopLifecycleOptions) {
    this.file = path.join(options.dataRoot, 'desktop-lifecycle.json');
    options.window.on('close', this.onClose);
    options.window.on('closed', this.onClosed);
  }
  async initialize() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.size <= 4096) {
        const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
        if (typeof value.closeToTray === 'boolean') this.preferences.closeToTray = value.closeToTray;
        if (value.locale === 'en' || value.locale === 'zh-CN') this.preferences.locale = value.locale;
      }
    } catch {
      /* Missing or obsolete preferences keep the default. */
    }
    try {
      const tray = await this.makeTray();
      if (this.disposed) tray.destroy();
      else this.tray = tray;
    } catch {
      this.preferences.closeToTray = false;
      this.preferences.available = false;
      this.preferences.error = 'error.trayUnavailable';
    }
    return this.state();
  }
  state(): DesktopLifecycleState {
    return structuredClone({
      ...this.preferences,
      lifecycleId: this.lifecycleId,
      ...(this.waiting ? { pendingClose: this.waiting.request } : {}),
    });
  }
  configure(request: { closeToTray: boolean; locale?: 'zh-CN' | 'en' }): Promise<DesktopLifecycleState> {
    const task = this.configureWork
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error('error.operationCancelled');
        if (
          typeof request?.closeToTray !== 'boolean' ||
          (request.locale !== undefined && !['en', 'zh-CN'].includes(request.locale))
        )
          throw new Error('rpc.invalidParams');
        const next = {
          ...this.preferences,
          closeToTray: request.closeToTray,
          locale: request.locale ?? this.preferences.locale,
          available: true,
          error: undefined,
        };
        let replacement: LifecycleTray | undefined;
        if (!this.tray || next.locale !== this.preferences.locale)
          replacement = await this.makeTray(next.locale);
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        try {
          if (this.disposed) throw new Error('error.operationCancelled');
          await fs.mkdir(this.options.dataRoot, { recursive: true });
          await fs.writeFile(
            temporary,
            JSON.stringify({ version: 1, closeToTray: next.closeToTray, locale: next.locale }),
            { flag: 'wx' },
          );
          if (this.disposed) throw new Error('error.operationCancelled');
          await fs.rename(temporary, this.file);
        } catch (error) {
          replacement?.destroy();
          await fs.unlink(temporary).catch(() => {});
          throw error;
        }
        if (this.disposed) {
          replacement?.destroy();
          throw new Error('error.operationCancelled');
        }
        if (replacement) {
          this.tray?.destroy();
          this.tray = replacement;
        }
        this.preferences = next;
        return this.state();
      });
    this.configureWork = task;
    return task;
  }
  private makeTray(locale = this.preferences.locale) {
    return (this.options.createTray ?? nativeTray)({
      png: createTrayIcon(),
      locale,
      show: () => this.restore(),
      quit: () => {
        void this.requestQuit().catch((error) => this.fail(error));
      },
    });
  }
  private restore() {
    if (!this.options.window.isDestroyed()) {
      if (this.options.window.isMinimized?.()) this.options.window.restore?.();
      this.options.window.show();
      this.options.window.focus();
    }
  }
  private onClose = (event: { preventDefault(): void }) => {
    if (this.preferences.quitting || this.disposed) return;
    event.preventDefault();
    if (this.preferences.closeToTray && this.tray && !this.quit) {
      this.options.window.hide();
      return;
    }
    void this.requestQuit().catch((error) => this.fail(error));
  };
  private onClosed = () => this.dispose();
  private send(request: AppCloseRequest) {
    sendToRenderer(this.options.window, APP_CLOSE_REQUEST_CHANNEL, request);
  }
  private finishRequest() {
    if (!this.waiting) return;
    clearTimeout(this.waiting.timer);
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting.resolve();
  }
  private fail(error: unknown) {
    this.preferences.error = error instanceof Error ? error.message : String(error);
    this.restore();
  }
  private issue(sharedDirty: boolean, error?: string) {
    if (this.disposed) return;
    const request = {
      id: randomUUID(),
      lifecycleId: this.lifecycleId,
      sharedDirty,
      ...(error ? { error } : {}),
    };
    if (this.waiting) {
      this.waiting.request = request;
      clearTimeout(this.waiting.timer);
      this.waiting.timer = this.requestTimer();
      this.send(request);
      return;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.waiting = { request, resolve, timer: this.requestTimer() };
    this.send(request);
    return promise;
  }
  private requestTimer() {
    const timer = setTimeout(() => {
      if (!this.waiting) return;
      // Saving can take longer than the renderer handshake timeout. Never
      // unlock collaboration while a shutdown transaction is in flight.
      if (this.replyWork) {
        this.waiting.timer = this.requestTimer();
        return;
      }
      const waiting = this.waiting;
      this.waiting = undefined;
      const cancelled = { ...waiting.request, cancelled: true, error: 'error.closeRequestTimeout' };
      // Expire the id before unlocking. A late renderer reply cannot race the
      // cancellation transaction and accidentally approve a newer shutdown.
      void this.options
        .cancelShutdown()
        .catch((error) => this.fail(error))
        .finally(() => {
          this.send(cancelled);
          waiting.resolve();
          this.fail(new Error('error.closeRequestTimeout'));
        });
    }, this.options.requestTimeoutMs ?? 60_000);
    timer.unref();
    return timer;
  }
  requestQuit(): Promise<void> {
    if (this.disposed || this.preferences.quitting) return Promise.resolve();
    if (this.quit) return this.quit;
    const work = (async () => {
      const dirty = await this.options.sharedDirty();
      if (this.disposed) return;
      if (!this.options.rendererReady()) {
        if (dirty) throw new Error('error.unsavedChanges');
        try {
          await this.options.prepareShutdown('clean');
          if (this.disposed) return;
          this.preferences.quitting = true;
          await this.options.exit();
        } catch (error) {
          this.preferences.quitting = false;
          await this.options.cancelShutdown();
          throw error;
        }
        return;
      }
      this.restore();
      await this.issue(dirty);
    })();
    this.quit = work.finally(() => {
      this.quit = undefined;
    });
    return this.quit;
  }
  reply(request: {
    id: string;
    decision: AppCloseDecision | 'committed' | 'commitFailed';
    error?: string;
  }): Promise<void> {
    if (!this.waiting || request.id !== this.waiting.request.id) throw new Error('error.closeRequestExpired');
    if (request.decision === 'committed' || request.decision === 'commitFailed') {
      if (!this.commit || this.commit.id !== request.id) throw new Error('error.closeRequestExpired');
      const pending = this.commit;
      this.commit = undefined;
      clearTimeout(pending.timer);
      if (request.decision === 'committed') pending.resolve();
      else pending.reject(new Error(request.error?.slice(0, 512) || 'error.closeSaveFailed'));
      return Promise.resolve();
    }
    if (!['clean', 'saved', 'discard', 'cancel'].includes(request.decision))
      throw new Error('rpc.invalidParams');
    if (this.replyWork) return this.replyWork;
    this.replyWork = this.handleReply(request.decision).finally(() => {
      this.replyWork = undefined;
    });
    return this.replyWork;
  }
  private async handleReply(decision: AppCloseDecision) {
    if (decision === 'cancel') {
      await this.options.cancelShutdown();
      this.finishRequest();
      return;
    }
    try {
      await this.options.prepareShutdown(decision);
      if (this.disposed) {
        await this.options.cancelShutdown();
        return;
      }
      if (this.options.rendererCommit) await this.commitRenderer(decision);
      if (this.disposed) {
        await this.options.cancelShutdown();
        return;
      }
      this.preferences.quitting = true;
      await this.options.exit();
      this.finishRequest();
    } catch (error) {
      this.preferences.quitting = false;
      await this.options.cancelShutdown();
      const message = error instanceof Error ? error.message : String(error);
      if (['error.unsavedChanges', 'error.closeNeedsReview'].includes(message)) this.issue(true);
      else {
        this.issue(await this.options.sharedDirty(), message);
        throw error;
      }
    }
  }
  private commitRenderer(decision: Exclude<AppCloseDecision, 'cancel'>) {
    if (!this.waiting) return Promise.reject(new Error('error.closeRequestExpired'));
    const request: AppCloseRequest = { ...this.waiting.request, phase: 'commit', decision };
    this.waiting.request = request;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.commit?.id !== request.id) return;
        this.commit = undefined;
        reject(new Error('error.closeRequestTimeout'));
      }, this.options.requestTimeoutMs ?? 60_000);
      timer.unref();
      this.commit = { id: request.id, resolve, reject, timer };
      this.send(request);
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.options.window.removeListener('close', this.onClose);
    this.options.window.removeListener('closed', this.onClosed);
    this.tray?.destroy();
    this.tray = undefined;
    if (this.commit) {
      clearTimeout(this.commit.timer);
      this.commit.reject(new Error('error.operationCancelled'));
      this.commit = undefined;
    }
    this.finishRequest();
  }
}
