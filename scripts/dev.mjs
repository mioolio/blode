import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createDevelopmentServerIdentity } from './dev-server.ts';
import { developmentRuntimeExecutables, ensureWindowsRuntimeIntegrity } from './windows-runtime.mjs';
import {
  hasFatalStartupError,
  hasReadyWindow,
  classifyElectronExit,
  resolveDevelopmentSandbox,
  rememberSandboxCompatibility,
  recoverStaleElectron,
  stopProcessTree,
} from './dev-runtime.mjs';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('..', import.meta.url));
process.chdir(repository);
const diagnoseOnly = process.argv.includes('--diagnose-startup');
const logDirectory = diagnoseOnly
  ? path.join(repository, '.tools', 'startup-diagnostics', `${Date.now()}-${process.pid}`)
  : path.join(repository, '.tools');
mkdirSync(logDirectory, { recursive: true });
const devUserData = path.resolve(
  (!diagnoseOnly && process.env.BLODE_DEV_USER_DATA) || path.join(logDirectory, 'dev-user-data'),
);
mkdirSync(devUserData, { recursive: true });
const startupLog = process.env.BLODE_DEV_LOG || path.join(logDirectory, 'dev-main.log');
const launcherLog = process.env.BLODE_DEV_LOG
  ? startupLog + '.launcher.log'
  : path.join(logDirectory, 'dev-launcher.log');
const launcherStarted = performance.now();
const report = (message) => {
  const line = `[dev +${((performance.now() - launcherStarted) / 1000).toFixed(2)}s] ${message}`;
  console.log(line);
  try {
    appendFileSync(launcherLog, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* Diagnostics must never prevent startup. */
  }
};
const stage = async (name, action) => {
  const started = performance.now();
  report(`${name}: starting`);
  const waiting = setInterval(
    () => report(`${name}: still running (${((performance.now() - started) / 1000).toFixed(1)}s)`),
    5000,
  );
  waiting.unref();
  try {
    const result = await action();
    report(`${name}: ready (${((performance.now() - started) / 1000).toFixed(2)}s)`);
    return result;
  } catch (error) {
    report(`${name}: failed (${((performance.now() - started) / 1000).toFixed(2)}s)`);
    throw error;
  } finally {
    clearInterval(waiting);
  }
};
const electronExecutable = require('electron');
// The OS releases this mutex even if the launcher is forcefully terminated.
const identity = createHash('sha256').update(devUserData.toLowerCase()).digest('hex').slice(0, 20);
const mutexPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\blode-dev-${identity}`
    : path.join(logDirectory, `dev-${identity}.sock`);
const mutex = net.createServer((socket) => socket.end());
let vite;
let rendererUrl;
const viteIdentity = createDevelopmentServerIdentity();
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
    if (!diagnoseOnly) await recoverStaleElectron(electronExecutable, devUserData);
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

let launchAttempt = 0;
const launch = async (args, softwareRendering = false, onReady) => {
  const attempt = ++launchAttempt;
  report(`Electron attempt ${attempt}: starting${args.length ? ` (${args.join(' ')})` : ''}`);
  rmSync(startupLog, { force: true });
  const { ELECTRON_RUN_AS_NODE: _, ...environment } = process.env;
  electron = spawn(electronExecutable, [`--user-data-dir=${devUserData}`, ...args, '.'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Electron is the interactive desktop application, not a background helper.
    windowsHide: false,
    env: {
      ...environment,
      ELECTRON_RENDERER_URL: rendererUrl,
      BLODE_DEV_USER_DATA: devUserData,
      BLODE_DEV_LOG: startupLog,
      BLODE_DEV_PARENT_PID: String(process.pid),
      ...(softwareRendering ? { BLODE_DISABLE_GPU: '1' } : {}),
    },
  });
  let timedOut = false;
  let readyObserved = false;
  let rememberReady;
  const observeReady = (log) => {
    if (readyObserved || timedOut || stopping || !hasReadyWindow(log)) return;
    readyObserved = true;
    clearTimeout(startupDeadline);
    clearInterval(startupWatch);
    console.log('Blode Studio is ready.');
    report(`Electron attempt ${attempt}: interface ready`);
    if (onReady)
      rememberReady = onReady(log).catch((error) => {
        report(`Startup compatibility could not be saved: ${error.message}`);
      });
  };
  const startupWatch = setInterval(() => {
    observeReady(readStartupLog());
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
    // Cleanup can cross the startup deadline after a perfectly normal close.
    // Stop startup observation at exit, before the process inventory await.
    clearInterval(startupWatch);
    clearTimeout(startupDeadline);
    const log = readStartupLog();
    observeReady(log);
    await rememberReady;
    // Keep failed-attempt evidence: the next launch resets the current log.
    try {
      copyFileSync(startupLog, `${startupLog}.attempt-${attempt}.log`);
    } catch {}
    report(`Electron attempt ${attempt}: exited (code ${code ?? 'unknown'})`);
    await stage('Electron process cleanup', () => recoverStaleElectron(electronExecutable, devUserData));
    return { code, timedOut, log };
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
  try {
    writeFileSync(launcherLog, '', 'utf8');
  } catch {}
  report('Preparing development session');
  const permissionsReady = stage('Runtime permissions (Electron/esbuild)', async () => {
    const executables = await developmentRuntimeExecutables(electronExecutable);
    const result = await ensureWindowsRuntimeIntegrity(executables);
    report(
      `Runtime permissions: checked ${result.files.length} executables, repaired ${result.files.filter((file) => file.repaired).length}`,
    );
  });
  // Only the owning launcher reaches this point. These preparations do not
  // depend on one another; keep permission checks and orphan recovery off the
  // build/server creation critical path. Wait for every task before cleanup so
  // a late-created server can never outlive a failed launch.
  const preparations = await Promise.allSettled([
    stage('Stale process recovery', () =>
      recoverStaleElectron(
        electronExecutable,
        devUserData,
        diagnoseOnly ? { stopProcessTree: async () => false } : {},
      ),
    ),
    permissionsReady,
    permissionsReady.then(() => stage('Main/preload build', () => import('./build.mjs'))),
    permissionsReady
      .then(() =>
        stage('Vite initialization', () =>
          createServer({
            ...(diagnoseOnly ? { cacheDir: path.join(logDirectory, 'vite-cache') } : {}),
            plugins: [viteIdentity.plugin],
            server: {
              host: '0.0.0.0',
              allowedHosts: true,
              port: diagnoseOnly ? 0 : 5173,
              strictPort: false,
            },
          }),
        ),
      )
      .then((server) => {
        // Vite belongs to this process, so an interrupted launcher cannot orphan a server.
        vite = server;
        vite.httpServer?.once('close', () => {
          if (!stopping) void quit(1);
        });
      }),
  ]);
  const failedPreparation = preparations.find((result) => result.status === 'rejected');
  if (failedPreparation) throw failedPreparation.reason;
  await stage('Vite dependency preparation/listen', () => vite.listen());
  rendererUrl = await stage('Vite ready check', () => viteIdentity.ready(vite));
  vite.printUrls();
  if (diagnoseOnly) {
    await stage('First HTML response (isolated cold dependency cache)', async () => {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Vite returned HTTP ${response.status}`);
      await response.text();
    });
    report(
      `Startup preparation complete. No Electron window or existing process was changed. Log: ${launcherLog}`,
    );
    await quit();
  }
  const sandboxOptions = {
    workspaceRoot: repository,
    electronExecutable,
    electronVersion: require('electron/package.json').version,
    profile: devUserData,
    override: process.env.BLODE_DEV_SANDBOX,
  };
  const sandbox = await resolveDevelopmentSandbox(sandboxOptions);
  let sandboxDisabled = sandbox.mode === 'no-sandbox';
  if (sandbox.source === 'verified')
    report('Using startup compatibility verified for this Electron version and profile');
  else if (sandbox.source === 'required') report('Sandbox required by BLODE_DEV_SANDBOX');
  else if (sandbox.source === 'disabled') report('Sandbox disabled by BLODE_DEV_SANDBOX');
  let sandboxFailure;
  let softwareRetried = false;
  while (!stopping) {
    const remember =
      sandboxDisabled && !softwareRetried && sandboxFailure
        ? async (recoveredLog) => {
            if (
              await rememberSandboxCompatibility(sandboxOptions, {
                failedAttempt: sandboxFailure,
                recoveredLog,
                sandboxDisabled: true,
                softwareRendering: softwareRetried,
              })
            )
              report('Startup compatibility verified and saved for this development profile');
          }
        : undefined;
    const result = await launch(sandboxDisabled ? ['--no-sandbox'] : [], softwareRetried, remember);
    if (stopping) break;
    const startupFailed = hasFatalStartupError(result.log);
    const outcome = classifyElectronExit(result, {
      sandbox: sandboxDisabled || !sandbox.canRetrySandbox,
      software: softwareRetried,
    });
    if (outcome.retry === 'sandbox') {
      sandboxDisabled = true;
      sandboxFailure = result;
      console.warn(
        '\nThe sandboxed renderer crashed during startup (0x80000003). Retrying once with --no-sandbox.\n',
      );
      continue;
    }
    if (outcome.retry === 'software') {
      softwareRetried = true;
      sandboxFailure = undefined;
      console.warn('\nThe window could not start. Retrying once with software rendering.\n');
      continue;
    }
    if (outcome.failed) {
      console.error(
        startupFailed
          ? `\nBlode Studio initialization failed (code ${result.code ?? 'unknown'}).`
          : `\nBlode Studio exited unexpectedly (code ${result.code ?? 'unknown'}).`,
      );
      console.error(result.log || 'Electron exited before writing its startup log.');
      console.error(`User data: ${devUserData}`);
    }
    await quit(outcome.exitCode);
  }
} catch (error) {
  console.error(error.message);
  // A second launcher must never clean up the first launcher's processes.
  if (!mutex.listening) process.exit(1);
  await quit(1);
}
