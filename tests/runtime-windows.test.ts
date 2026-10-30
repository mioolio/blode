import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type { RuntimeWindows } from '../src/core/runtime-windows';
import type { RuntimeViewContribution } from '../src/shared/plugins';

// Exercise the actual registry without starting Electron or showing native windows.
const compiled = await build({
  entryPoints: ['src/core/runtime-windows.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  write: false,
  logLevel: 'silent',
});
const nativeRequire = createRequire(import.meta.url);
function fixture(rendererUrl?: string) {
  const created: WindowDouble[] = [];
  class WindowDouble extends EventEmitter {
    destroyed = false;
    minimized = false;
    shown = 0;
    focused = 0;
    restored = 0;
    menuRemoved = false;
    url?: string;
    file?: { path: string; options: { hash: string } };
    windowOpen?: () => { action: string };
    loaded = (() => {
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    })();
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: (handler: () => { action: string }) => {
        this.windowOpen = handler;
      },
    });
    constructor(readonly options: Record<string, any>) {
      super();
      created.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return this.minimized;
    }
    removeMenu() {
      this.menuRemoved = true;
    }
    restore() {
      this.minimized = false;
      this.restored++;
    }
    show() {
      this.shown++;
    }
    focus() {
      this.focused++;
    }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit('closed');
      }
    }
    loadURL(url: string) {
      this.url = url;
      return this.loaded.promise;
    }
    loadFile(path: string, options: { hash: string }) {
      this.file = { path, options };
      return this.loaded.promise;
    }
  }
  const module = { exports: {} as { RuntimeWindows: typeof RuntimeWindows } };
  const isolatedRequire = (id: string) =>
    id === 'electron' ? { BrowserWindow: WindowDouble } : nativeRequire(id);
  new Function('module', 'exports', 'require', compiled.outputFiles[0].text)(
    module,
    module.exports,
    isolatedRequire,
  );
  const registry = new module.exports.RuntimeWindows({
    preload: '/app/preload.cjs',
    rendererFile: '/app/renderer/index.html',
    rendererUrl,
    background: () => '#ffffff',
  });
  const view = (id = 'cpu'): RuntimeViewContribution => ({
    id,
    label: 'CPU',
    location: 'window',
    file: 'views/cpu.html',
  });
  const owner = (window: WindowDouble) =>
    registry.owner(window.webContents as unknown as Parameters<RuntimeWindows['owner']>[0]);
  return { registry, created, view, owner };
}

test('runtime windows coalesce simultaneous opens, restore existing windows and isolate native privileges', async () => {
  const f = fixture('http://127.0.0.1:5173/');
  try {
    const first = f.registry.open('vendor.board', f.view('cpu state'));
    const concurrent = f.registry.open('vendor.board', f.view('cpu state'));
    assert.equal(f.created.length, 1);
    const window = f.created[0];
    assert.equal(window.shown, 0, 'a loading window must remain hidden');
    assert.equal(f.owner(window)?.pluginId, 'vendor.board');
    assert.equal(window.options.frame, false);
    assert.equal(window.options.show, false);
    assert.deepEqual(window.options.webPreferences, {
      additionalArguments: ['--blode-frameless'],
      preload: '/app/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
    assert.equal(window.menuRemoved, true);
    assert.deepEqual(window.windowOpen?.(), { action: 'deny' });
    let prevented = false;
    window.webContents.emit('will-navigate', {
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(new URL(window.url!).hash, '#/runtime-view/vendor.board/cpu%20state');
    window.loaded.resolve();
    await Promise.all([first, concurrent]);
    assert.equal(window.shown, 1);
    window.minimized = true;
    await f.registry.open('vendor.board', f.view('cpu state'));
    assert.equal(f.created.length, 1);
    assert.equal(window.restored, 1);
    assert.equal(window.focused, 1);
    assert.equal(window.shown, 2);
  } finally {
    f.registry.close();
  }
});

test('failed runtime window loads release ownership and allow a fresh retry', async () => {
  const f = fixture();
  try {
    const opening = f.registry.open('vendor.board', f.view());
    const failed = assert.rejects(opening, /renderer-unavailable/);
    const first = f.created[0];
    assert.deepEqual(first.file, {
      path: '/app/renderer/index.html',
      options: { hash: '/runtime-view/vendor.board/cpu' },
    });
    first.loaded.reject(new Error('renderer-unavailable'));
    await failed;
    assert.equal(first.destroyed, true);
    assert.equal(first.shown, 0);
    assert.equal(f.owner(first), undefined);
    const retry = f.registry.open('vendor.board', f.view());
    assert.equal(f.created.length, 2);
    f.created[1].loaded.resolve();
    await retry;
    assert.equal(f.created[1].shown, 1);
  } finally {
    f.registry.close();
  }
});

test('general and board views have separate ownership and disabling closes only extension windows', async () => {
  const f = fixture();
  try {
    const board = f.registry.open('same', f.view());
    const extension = f.registry.open('same', f.view(), 'extension');
    assert.equal(f.created.length, 2);
    const [first, second] = f.created;
    assert.equal(f.owner(first)?.kind, 'runtime');
    assert.equal(f.owner(second)?.kind, 'extension');
    assert.equal(second.file?.options.hash, '/extension-view/same/cpu');
    first.loaded.resolve();
    second.loaded.resolve();
    await Promise.all([board, extension]);
    f.registry.retainExtensions(new Set(['same']));
    assert.equal(second.destroyed, false);
    f.registry.retainExtensions(new Set());
    assert.equal(second.destroyed, true);
    assert.equal(first.destroyed, false);
    assert.equal(f.owner(second), undefined);
  } finally {
    f.registry.close();
  }
});

test('closing the registry while a view loads prevents late show and further opens', async () => {
  const f = fixture();
  const opening = f.registry.open('vendor.board', f.view());
  const cancelled = assert.rejects(opening, /operationCancelled/);
  const window = f.created[0];
  f.registry.close();
  assert.equal(window.destroyed, true);
  assert.equal(f.owner(window), undefined);
  window.loaded.resolve();
  await cancelled;
  assert.equal(window.shown, 0);
  await assert.rejects(f.registry.open('vendor.board', f.view()), /operationCancelled/);
});

test('loading runtime windows count toward the limit and native close releases a slot', async () => {
  const f = fixture();
  try {
    const loading = Array.from({ length: 8 }, (_, index) =>
      f.registry.open('vendor.board', f.view(`view-${index}`)),
    );
    await assert.rejects(f.registry.open('vendor.board', f.view('overflow')), /limitExceeded/);
    for (const window of f.created) window.loaded.resolve();
    await Promise.all(loading);
    f.created[0].destroy();
    const replacement = f.registry.open('vendor.board', f.view('replacement'));
    f.created.at(-1)!.loaded.resolve();
    await replacement;
    assert.equal(f.created.length, 9);
  } finally {
    f.registry.close();
  }
});
