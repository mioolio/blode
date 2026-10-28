import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const executeFile = promisify(execFile);

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
