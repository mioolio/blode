import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const executeFile = promisify(execFile);

/** A mounted shell is independent of successful background service startup. */
export function hasFatalStartupError(log) {
  return /^\d{4}-\d{2}-\d{2}T\S+ fatal(?:\s|$)/m.test(log);
}

/** A clean process exit takes precedence over earlier, recovered renderer errors. */
export function classifyElectronExit(result, retries = {}) {
  const ready = hasReadyWindow(result.log);
  const fatal = hasFatalStartupError(result.log);
  if (result.code === 0 && !result.timedOut && !fatal) return { retry: null, failed: false, exitCode: 0 };
  const chromiumCrash =
    result.code === 0x80000003 ||
    result.code === -2147483645 ||
    /render-process-gone crashed exit=-2147483645\b/.test(result.log);
  if (!ready && chromiumCrash && !retries.sandbox) return { retry: 'sandbox', failed: true, exitCode: 1 };
  if (
    !ready &&
    !retries.software &&
    (chromiumCrash ||
      result.timedOut ||
      /(?:gpu-process|child-process-gone GPU).*?(?:crashed|abnormal-exit)/i.test(result.log))
  )
    return { retry: 'software', failed: true, exitCode: 1 };
  const failed = !ready || fatal || result.code !== 0;
  return { retry: null, failed, exitCode: failed ? result.code || 1 : 0 };
}

function sandboxOverride(value) {
  const selected = String(value ?? 'auto')
    .trim()
    .toLowerCase();
  if (!selected || selected === 'auto') return 'auto';
  if (selected === '1' || selected === 'required') return 'required';
  if (selected === '0' || selected === 'disabled') return 'disabled';
  throw new Error('BLODE_DEV_SANDBOX must be auto, 1/required, or 0/disabled.');
}

/** Only the main-process boot marker proves the interface mounted. */
export function hasReadyWindow(log) {
  return /^\d{4}-\d{2}-\d{2}T\S+ window ready(?:\s|$)/m.test(log);
}

async function sandboxRecord(options, create = false) {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  const executable = windowsPath(options.electronExecutable);
  const profile = windowsPath(options.profile);
  if (!executable || !profile || !options.electronVersion || options.electronVersion.length > 128)
    return null;
  const workspace = await fs.realpath(path.resolve(options.workspaceRoot));
  const directory = path.join(workspace, '.tools');
  if (create) await fs.mkdir(directory, { recursive: true });
  const info = await fs.lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  const profileKey = createHash('sha256').update(profile).digest('hex').slice(0, 20);
  const key = createHash('sha256')
    .update(JSON.stringify(['blode-dev-sandbox-v1', 'win32', options.electronVersion, executable, profile]))
    .digest('hex');
  return { file: path.join(directory, `dev-sandbox-${profileKey}.json`), key };
}

/** Compatibility is local to one Windows development checkout/profile and Electron runtime. */
export async function resolveDevelopmentSandbox(options) {
  const override = sandboxOverride(options.override);
  if (override === 'required') return { mode: 'sandbox', canRetrySandbox: false, source: 'required' };
  if (override === 'disabled') return { mode: 'no-sandbox', canRetrySandbox: false, source: 'disabled' };
  try {
    const record = await sandboxRecord(options);
    if (record) {
      const info = await fs.lstat(record.file).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink() && info.size <= 1024) {
        const cached = JSON.parse(await fs.readFile(record.file, 'utf8'));
        if (
          cached?.mode === 'no-sandbox' &&
          cached.key === record.key &&
          Object.keys(cached).sort().join(',') === 'key,mode'
        )
          return { mode: 'no-sandbox', canRetrySandbox: false, source: 'verified' };
      }
    }
  } catch {
    // Missing, damaged or unwritable development caches never block startup.
  }
  return { mode: 'sandbox', canRetrySandbox: true, source: 'default' };
}

/** Store only a crash followed by a mounted no-sandbox attempt, never an ordinary close or GPU retry. */
export async function rememberSandboxCompatibility(options, evidence) {
  if (
    sandboxOverride(options.override) !== 'auto' ||
    evidence.sandboxDisabled !== true ||
    evidence.softwareRendering ||
    evidence.failedAttempt.timedOut ||
    hasReadyWindow(evidence.failedAttempt.log) ||
    !hasReadyWindow(evidence.recoveredLog) ||
    hasFatalStartupError(evidence.recoveredLog)
  )
    return false;
  const failed = evidence.failedAttempt;
  const rendererCrash = /^\d{4}-\d{2}-\d{2}T\S+ render-process-gone crashed exit=-2147483645\b/m.test(
    failed.log,
  );
  // Electron may return zero after its bootstrap catch calls app.quit(). The
  // renderer's crash plus a fatal boot marker distinguishes this from a close.
  if (
    failed.code !== 0x80000003 &&
    failed.code !== -2147483645 &&
    !(hasFatalStartupError(failed.log) && rendererCrash)
  )
    return false;
  let temporary;
  try {
    const record = await sandboxRecord(options, true);
    if (!record) return false;
    temporary = `${record.file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ mode: 'no-sandbox', key: record.key }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, record.file);
    temporary = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

/** The caller must own this PID; never selects a process by a global image name. */
export async function stopProcessTree(pid, options = {}) {
  if (!validPid(pid) || pid === process.pid) throw new Error('Invalid owned process ID');
  if ((options.platform ?? process.platform) === 'win32') {
    try {
      await (options.execFile ?? executeFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000,
      });
      return true;
    } catch (error) {
      // taskkill returns 128 when the PID has already exited.
      if (Number(error.code) === 128) return false;
      throw error;
    }
  }
  try {
    (options.kill ?? process.kill)(pid, 'SIGTERM');
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Parse Windows quoted arguments, including whole quoted --key=value tokens. */
function windowsArguments(commandLine) {
  const args = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < commandLine.length; index++) {
    const character = commandLine[index];
    if (/\s/.test(character) && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    started = true;
    if (character === '\\') {
      let count = 1;
      while (commandLine[index + 1] === '\\') {
        count++;
        index++;
      }
      if (commandLine[index + 1] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        index++;
        if (count % 2) current += '"';
        else quoted = !quoted;
      } else current += '\\'.repeat(count);
    } else if (character === '"') quoted = !quoted;
    else current += character;
  }
  if (started) args.push(current);
  return args;
}

function windowsPath(value) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value)) return undefined;
  return path.win32
    .normalize(value)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function processIdentity(entry) {
  const pid = Number(entry.ProcessId);
  const parentPid = Number(entry.ParentProcessId);
  return validPid(pid) && Number.isSafeInteger(parentPid) && parentPid >= 0 ? { pid, parentPid } : undefined;
}

async function inventory(options) {
  if (options.inventory)
    return typeof options.inventory === 'function' ? options.inventory() : options.inventory;
  if ((options.platform ?? process.platform) !== 'win32') return [];
  const powershell = path.win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  // No caller-controlled path or text is interpolated into this fixed script.
  const script =
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await (options.execFile ?? executeFile)(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(
    String(stdout)
      .replace(/^\uFEFF/, '')
      .trim() || '[]',
  );
  return parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
}

/** Only orphaned trees with the exact Electron executable/profile are eligible. */
export async function findStaleElectronProcesses(electronExecutable, profile, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32' && !options.inventory) return [];
  const expectedExecutable = windowsPath(electronExecutable);
  const expectedProfile = windowsPath(profile);
  if (!expectedExecutable || !expectedProfile)
    throw new Error('Expected absolute Electron executable and profile paths');
  const entries = await inventory(options);
  const matching = entries.flatMap((entry) => {
    const identity = processIdentity(entry);
    if (
      !identity ||
      identity.pid === process.pid ||
      windowsPath(entry.ExecutablePath) !== expectedExecutable ||
      typeof entry.CommandLine !== 'string'
    )
      return [];
    const args = windowsArguments(entry.CommandLine);
    const profiles = [];
    for (let index = 1; index < args.length; index++) {
      if (args[index] === '--') break;
      if (args[index] === '--user-data-dir') profiles.push(args[++index]);
      else if (args[index].startsWith('--user-data-dir='))
        profiles.push(args[index].slice('--user-data-dir='.length));
    }
    // Ambiguous duplicate switches are never a basis for terminating a process.
    return profiles.length === 1 && windowsPath(profiles[0]) === expectedProfile ? [identity] : [];
  });
  const livePids = new Set(entries.map((entry) => Number(entry.ProcessId)).filter(validPid));
  const stale = new Set(matching.filter((entry) => !livePids.has(entry.parentPid)).map((entry) => entry.pid));
  // A main process with a living launcher is an active session, even if an older
  // launcher predates the current development mutex. Preserve its entire tree.
  let changed;
  do {
    changed = false;
    for (const entry of matching) {
      if (!stale.has(entry.pid) && stale.has(entry.parentPid)) {
        stale.add(entry.pid);
        changed = true;
      }
    }
  } while (changed);
  return matching.filter((entry) => stale.has(entry.pid));
}

async function stopMatchedTrees(matches, options) {
  const matchedPids = new Set(matches.map(({ pid }) => pid));
  let stopped = 0;
  for (const match of matches) {
    if (matchedPids.has(match.parentPid)) continue;
    if (await (options.stopProcessTree ?? stopProcessTree)(match.pid, options)) stopped++;
  }
  return stopped;
}

/** Call only after acquiring the current checkout's development-session mutex. */
export async function recoverStaleElectron(electronExecutable, profile, options = {}) {
  return stopMatchedTrees(await findStaleElectronProcesses(electronExecutable, profile, options), options);
}

/** Legacy Vite children are eligible only when their exact Node parent has gone. */
export async function findStaleVite(viteScript, nodeExecutable, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32' && !options.inventory) return [];
  const expectedScript = windowsPath(viteScript);
  const expectedNode = windowsPath(nodeExecutable);
  if (!expectedScript || !expectedNode)
    throw new Error('Expected absolute Vite script and Node executable paths');
  const entries = await inventory(options);
  const livePids = new Set(entries.map((entry) => Number(entry.ProcessId)).filter(validPid));
  return entries.flatMap((entry) => {
    const identity = processIdentity(entry);
    if (
      !identity ||
      identity.pid === process.pid ||
      livePids.has(identity.parentPid) ||
      windowsPath(entry.ExecutablePath) !== expectedNode ||
      typeof entry.CommandLine !== 'string'
    )
      return [];
    const args = windowsArguments(entry.CommandLine);
    // The old launcher invokes node <absolute-vite-script> --host ..., without flags before it.
    return windowsPath(args[1]) === expectedScript ? [identity] : [];
  });
}

export async function recoverStaleVite(viteScript, nodeExecutable, options = {}) {
  return stopMatchedTrees(await findStaleVite(viteScript, nodeExecutable, options), options);
}

/** Recover both legacy child types from one fresh inventory, after taking the session mutex. */
export async function recoverStaleDevProcesses(
  electronExecutable,
  profile,
  viteScript,
  nodeExecutable,
  options = {},
) {
  if ((options.platform ?? process.platform) !== 'win32' && !options.inventory) return 0;
  const entries = await inventory(options);
  const shared = { ...options, inventory: entries };
  const [electron, vite] = await Promise.all([
    findStaleElectronProcesses(electronExecutable, profile, shared),
    findStaleVite(viteScript, nodeExecutable, shared),
  ]);
  return stopMatchedTrees([...electron, ...vite], options);
}
