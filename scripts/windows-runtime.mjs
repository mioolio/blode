import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const helper = fileURLToPath(new URL('./windows-runtime.ps1', import.meta.url));

async function runtimeExecutables() {
  const files = [];
  async function walk(directory) {
    const info = await lstat(directory).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) await walk(file);
      else if (item.isFile() && path.extname(item.name).toLowerCase() === '.exe') files.push(file);
    }
  }
  // These are installed application runtimes, not user projects or system files.
  for (const root of ['node_modules/electron/dist', 'tools', '.tools/esptool-venv'])
    await walk(path.join(repository, root));
  return files.sort();
}

/** Restore normal user integrity on local runtimes without changing their DACLs. */
export async function ensureWindowsRuntimeIntegrity(executables, { repair = true } = {}) {
  if (process.platform !== 'win32') return { processIntegrity: null, files: [] };
  const files = [...new Set((executables ?? (await runtimeExecutables())).map((file) => path.resolve(file)))];
  if (!files.length) return { processIntegrity: null, files: [] };
  const shell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helper,
        ...(repair ? [] : ['-CheckOnly']),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding('utf8').on('data', (value) => {
      stdout += value;
    });
    child.stderr.setEncoding('utf8').on('data', (value) => {
      stderr += value;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdin.on('error', () => {}); // A failed helper may close before reading the list.
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Windows runtime integrity check failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
      } catch (error) {
        reject(new Error('Invalid Windows runtime integrity result', { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify(files));
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = await ensureWindowsRuntimeIntegrity(undefined, {
      repair: !process.argv.includes('--check'),
    });
    const changed = report.files.filter((file) => file.repaired);
    console.log(`Windows runtimes: checked ${report.files.length}, repaired ${changed.length}.`);
    for (const file of changed) console.log(`Restored Medium integrity: ${file.path}`);
    if (report.files.some((file) => file.after < 8192)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
