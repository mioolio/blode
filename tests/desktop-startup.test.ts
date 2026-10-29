import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execute = promisify(execFile);

test('desktop renders before proxy/services finish and queues early RPC behind initialization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blode-startup-test-'));
  try {
    const bundle = path.join(directory, 'main.cjs');
    const harness = path.join(directory, 'harness.cjs');
    const built = await build({
      entryPoints: ['src/core/main.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron', 'serialport'],
      logLevel: 'silent',
      write: false,
    });
    await writeFile(bundle, built.outputFiles[0]!.contents);
    // Exercise real bootstrap ordering without creating a window, querying PnP,
    // opening ports, or joining an existing desktop development session.
    await writeFile(
      harness,
      String.raw`
      const assert = require('node:assert/strict');
      const { EventEmitter } = require('node:events');
      const Module = require('node:module');
      const path = require('node:path');
      let proxyCalls = 0;
      let loadStarted = false;
      let desktop;
      const handlers = new Map();
      const ipcMain = new EventEmitter();
      ipcMain.handle = (name, handler) => handlers.set(name, handler);
      const app = Object.assign(new EventEmitter(), {
        isPackaged: false,
        commandLine: { appendSwitch() {}, getSwitchValue() { return ''; } },
        setName() {}, disableHardwareAcceleration() {},
        requestSingleInstanceLock() { return true; },
        getPath() { return __dirname; },
        getAppPath() { return process.cwd(); },
        whenReady() { return Promise.resolve(); },
        quit() { throw new Error('unexpected bootstrap failure'); },
      });
      class BrowserWindow extends EventEmitter {
        constructor() {
          super();
          desktop = this;
          this.shows = 0;
          this.webContents = Object.assign(new EventEmitter(), {
            mainFrame: {},
            session: { setPermissionRequestHandler() {} },
            setWindowOpenHandler() {},
            isDestroyed() { return false; },
          });
        }
        removeMenu() {} hookWindowMessage() {} isDestroyed() { return false; }
        show() { this.shows++; }
        minimize() { this.minimized = true; }
        close() { this.emit('closed'); }
        loadFile() { return this.startLoad(); }
        loadURL() { return this.startLoad(); }
        startLoad() {
          loadStarted = true;
          setImmediate(async () => {
            try {
              assert.equal(proxyCalls, 1);
              assert.equal(loadStarted, true);
              assert.ok(handlers.has('blode:request'));
              this.emit('ready-to-show');
              assert.equal(this.shows, 1, 'static first paint can be shown immediately');
              ipcMain.emit('blode:renderer-ready', { sender: {}, senderFrame: {} });
              assert.equal(this.shows, 1, 'foreign contents cannot signal readiness');
              const event = { sender: this.webContents, senderFrame: this.webContents.mainFrame };
              await handlers.get('blode:request')(event, 'windowAction', ['minimize']);
              assert.equal(this.minimized, true, 'frameless controls must work before core is ready');
              ipcMain.emit('blode:renderer-ready', event);
              assert.equal(this.shows, 2, 'mounted renderer signals readiness without polling');
              let settled = false;
              const early = handlers.get('blode:request')(event, 'getState', []);
              early.then(
                () => { settled = true; }, () => { settled = true; },
              );
              await new Promise((resolve) => setTimeout(resolve, 10));
              assert.equal(settled, false, 'RPC must not enter a partially created core');
              this.close();
              await assert.rejects(early, /error.operationCancelled/);
              console.log('startup-order-ok');
              process.exit(0);
            } catch (error) { console.error(error); process.exit(1); }
          });
          return Promise.resolve();
        }
      }
      const electron = {
        app, BrowserWindow, ipcMain,
        nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
        session: { defaultSession: { resolveProxy() {
          proxyCalls++;
          assert.ok(loadStarted, 'window must begin loading before proxy lookup');
          return new Promise(() => {});
        } } },
        dialog: { showErrorBox() { throw new Error('unexpected error dialog'); } },
        net: {}, shell: {},
      };
      const originalLoad = Module._load;
      Module._load = function (id, ...args) {
        return id === 'electron' ? electron : originalLoad.call(this, id, ...args);
      };
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.ELECTRON_RENDERER_URL;
      delete process.env.BLODE_DEV_PARENT_PID;
      delete process.env.BLODE_DEV_USER_DATA;
      delete process.env.BLODE_DEV_LOG;
      require(path.join(__dirname, 'main.cjs'));
      setTimeout(() => { console.error('startup-order-timeout'); process.exit(1); }, 5000).unref();
    `,
    );
    const { stdout } = await execute(process.execPath, [harness], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_PATH: path.join(process.cwd(), 'node_modules') },
      timeout: 10_000,
      windowsHide: true,
    });
    assert.match(stdout, /startup-order-ok/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
