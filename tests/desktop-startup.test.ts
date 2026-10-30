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
      const powerMonitor = new EventEmitter();
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
          this.visible = false;
          this.focused = true;
          this.minimized = false;
          this.attentionEvents = [];
          const owner = this;
          this.webContents = Object.assign(new EventEmitter(), {
            mainFrame: {
              detached: false,
              isDestroyed() { return false; },
              send(channel, value) { if(channel === 'blode:window-attention') owner.attentionEvents.push(value); },
            },
            session: { setPermissionRequestHandler() {} },
            setWindowOpenHandler() {},
            isDestroyed() { return false; },
            send(channel, value) { if(channel === 'blode:window-attention') owner.attentionEvents.push(value); },
          });
        }
        removeMenu() {} hookWindowMessage() {} isDestroyed() { return false; }
        isVisible() { return this.visible; }
        isFocused() { return this.focused; }
        isMinimized() { return this.minimized; }
        show() { this.shows++; this.visible = true; this.minimized = false; this.emit('show'); }
        minimize() { this.minimized = true; this.emit('minimize'); }
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
              const invoke = (method, args = [], sender = event) => handlers.get('blode:request')(sender, method, args);
              assert.deepEqual(await invoke('windowAttention'), {visible:true,focused:true,epoch:undefined}, 'private snapshot works while services are pending');
              await assert.rejects(invoke('windowAttention', [], {sender:{},senderFrame:{}}), /error.unauthorized/);
              await assert.rejects(invoke('windowAttention', [], {sender:this.webContents,senderFrame:{}}), /error.unauthorized/);
              await assert.rejects(invoke('windowAttention', [true]), /error.unauthorized/);
              await handlers.get('blode:request')(event, 'windowAction', ['minimize']);
              assert.equal(this.minimized, true, 'frameless controls must work before core is ready');
              assert.deepEqual(await invoke('windowAttention'), {visible:false,focused:false,epoch:undefined});
              ipcMain.emit('blode:renderer-ready', event);
              assert.equal(this.shows, 2, 'mounted renderer signals readiness without polling');
              this.focused = false;
              this.emit('blur');
              assert.equal((await invoke('windowAttention')).focused, false);
              this.focused = true;
              this.emit('focus');
              powerMonitor.emit('lock-screen');
              assert.deepEqual(await invoke('windowAttention'), {visible:false,focused:false,epoch:undefined});
              powerMonitor.emit('unlock-screen');
              assert.equal((await invoke('windowAttention')).focused, true);
              powerMonitor.emit('suspend');
              assert.equal((await invoke('windowAttention')).focused, false);
              powerMonitor.emit('resume');
              assert.equal((await invoke('windowAttention')).focused, true);
              assert.ok(this.attentionEvents.length > 0, 'window lifecycle publishes private snapshots');
              let settled = false;
              const early = handlers.get('blode:request')(event, 'getState', []);
              early.then(
                () => { settled = true; }, () => { settled = true; },
              );
              await new Promise((resolve) => setTimeout(resolve, 10));
              assert.equal(settled, false, 'RPC must not enter a partially created core');
              this.close();
              for(const name of ['lock-screen','unlock-screen','suspend','resume'])
                assert.equal(powerMonitor.listenerCount(name), 0, 'a closed window releases power listeners');
              assert.deepEqual(await early, {__blodeIpcCancelled:true}, 'shutdown cancellation is returned without an ipcMain handler error');
              console.log('startup-order-ok');
              process.exit(0);
            } catch (error) { console.error(error); process.exit(1); }
          });
          return Promise.resolve();
        }
      }
      const electron = {
        app, BrowserWindow, ipcMain, powerMonitor,
        protocol: { registerSchemesAsPrivileged(schemes) {
          assert.equal(schemes[0].scheme, 'blode-runtime-ui');
          assert.equal(schemes[0].privileges.secure, true);
        }, handle() {} },
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
