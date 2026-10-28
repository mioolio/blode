import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { ensureWindowsRuntimeIntegrity } from './windows-runtime.mjs';
import { recoverStaleElectron, recoverStaleVite, stopProcessTree } from './dev-runtime.mjs';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repository);
const logDirectory = path.join(repository, '.tools');
mkdirSync(logDirectory, { recursive: true });
const devUserData = path.resolve(process.env.BLODE_DEV_USER_DATA || path.join(logDirectory, 'dev-user-data'));
mkdirSync(devUserData, { recursive: true });
const startupLog = path.join(logDirectory, 'dev-main.log');
const electronExecutable = require('electron');
const viteScript = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
// The OS releases this mutex even if the launcher is forcefully terminated.
const identity = createHash('sha256').update(devUserData.toLowerCase()).digest('hex').slice(0, 20);
const mutexPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\blode-dev-${identity}`
    : path.join(logDirectory, `dev-${identity}.sock`);
const mutex = net.createServer((socket) => socket.end());
let vite;
let electron;
let stopping = false;
let ownsSession = false;
let cleanupPromise;
const readStartupLog = () => {
  try {
    return readFileSync(startupLog, 'utf8').trim();
  } catch {
    return '';
  }
};
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    stopping = true;
    if (!ownsSession) return;
    if (electron?.pid && electron.exitCode === null) await stopProcessTree(electron.pid);
    await recoverStaleElectron(electronExecutable, devUserData);
    await vite?.close();
    if (mutex.listening) await new Promise((resolve) => mutex.close(resolve));
  })());
const quit = async (code = 0) => {
  try {
    await cleanup();
  } catch (error) {
    console.error('Development cleanup failed:', error.message);
    code ||= 1;
  }
  process.exit(code);
};
process.once('SIGINT', () => void quit());
process.once('SIGTERM', () => void quit());
process.once('uncaughtException', (error) => {
  console.error(error);
  void quit(1);
});
process.once('unhandledRejection', (error) => {
  console.error(error);
  void quit(1);
});

const launch = async (args, softwareRendering = false) => {
  rmSync(startupLog, { force: true });
  const { ELECTRON_RUN_AS_NODE: _, ...environment } = process.env;
  electron = spawn(electronExecutable, [`--user-data-dir=${devUserData}`, ...args, '.'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Electron is the interactive desktop application, not a background helper.
    windowsHide: false,
    env: {
      ...environment,
      ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173',
      BLODE_DEV_USER_DATA: devUserData,
      BLODE_DEV_LOG: startupLog,
      BLODE_DEV_PARENT_PID: String(process.pid),
      ...(softwareRendering ? { BLODE_DISABLE_GPU: '1' } : {}),
    },
  });
  let timedOut = false;
  const startupWatch = setInterval(() => {
    if (readStartupLog().includes('window ready')) {
      clearTimeout(startupDeadline);
      clearInterval(startupWatch);
      console.log('Blode Studio is ready.');
    }
  }, 250);
  const startupDeadline = setTimeout(() => {
    timedOut = true;
    console.error(
      'Blode did not create a visible window within 30 seconds. Recovering the owned process tree.',
    );
    if (electron?.pid) void stopProcessTree(electron.pid);
  }, 30_000);
  try {
    const code = await new Promise((resolve, reject) => {
      electron.once('error', reject);
      electron.once('exit', (code) => resolve(code));
    });
    await recoverStaleElectron(electronExecutable, devUserData);
    return { code, timedOut, log: readStartupLog() };
  } finally {
    clearInterval(startupWatch);
    clearTimeout(startupDeadline);
  }
};

try {
  await new Promise((resolve, reject) => {
    mutex.once('error', reject);
    mutex.listen(mutexPath, resolve);
  }).catch((error) => {
    if (error.code === 'EADDRINUSE')
      throw new Error(
        'This Blode development session is already running. Its existing window owns this profile.',
      );
    throw error;
  });
  ownsSession = true;
  await recoverStaleElectron(electronExecutable, devUserData);
  await recoverStaleVite(viteScript, process.execPath);
  await ensureWindowsRuntimeIntegrity();
  await import('./build.mjs');
  // Vite belongs to this process, so an interrupted launcher cannot orphan a server.
  vite = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: true } });
  vite.httpServer?.once('close', () => {
    if (!stopping) void quit(1);
  });
  await vite.listen();
  vite.printUrls();
  let sandboxRetried = false;
  let softwareRetried = false;
  while (!stopping) {
    const result = await launch(sandboxRetried ? ['--no-sandbox'] : [], softwareRetried);
    if (stopping) break;
    const early = !result.log.includes('window ready');
    const chromiumCrash =
      result.code === 0x80000003 ||
      result.code === -2147483645 ||
      /render-process-gone crashed exit=-2147483645\b/.test(result.log);
    if (early && chromiumCrash && !sandboxRetried) {
      sandboxRetried = true;
      console.warn(
        '\nChromium failed during startup. Its processes have been stopped; retrying once with --no-sandbox.\n',
      );
      continue;
    }
    if (
      early &&
      (chromiumCrash ||
        result.timedOut ||
        /(?:gpu-process|child-process-gone GPU).*?(?:crashed|abnormal-exit)/i.test(result.log)) &&
      !softwareRetried
    ) {
      softwareRetried = true;
      console.warn('\nThe window could not start. Retrying once with software rendering.\n');
      continue;
    }
    if (early) {
      console.error(`\nBlode Studio exited before its window was ready (code ${result.code ?? 'unknown'}).`);
      console.error(result.log || 'Electron exited before writing its startup log.');
      console.error(`User data: ${devUserData}`);
    }
    await quit(early ? 1 : (result.code ?? 0));
  }
} catch (error) {
  console.error(error.message);
  // A second launcher must never clean up the first launcher's processes.
  if (!mutex.listening) process.exit(1);
  await quit(1);
}
