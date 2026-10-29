import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const helper = fileURLToPath(new URL('./windows-runtime.ps1', import.meta.url));

async function regularExecutable(file) {
  const info = await lstat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  return !!info?.isFile() && !info.isSymbolicLink() && path.extname(file).toLowerCase() === '.exe';
}

/** Startup needs only the executable children used by Electron and the bundler.
 * Compiler/SDK trees stay in the explicit full repair/install workflow. */
export async function developmentRuntimeExecutables(electronExecutable, root = repository) {
  if (process.platform !== 'win32') return [];
  const candidates = [path.resolve(electronExecutable)];
  const localRequire = createRequire(path.join(path.resolve(root), 'package.json'));
  try {
    // Resolve from esbuild itself so a nested optional dependency matches the
    // executable its loader will actually spawn. Rolldown runs as a .node
    // binding in the existing Node process, not as another child executable.
    const esbuildEntry = localRequire.resolve('esbuild');
    const esbuildRequire = createRequire(esbuildEntry);
    const override = process.env.ESBUILD_BINARY_PATH;
    if (
      override &&
      override !== '/usr/bin/esbuild' &&
      (await regularExecutable(path.resolve(root, override)))
    )
      candidates.push(path.resolve(root, override));
    else {
      try {
        candidates.push(esbuildRequire.resolve(`@esbuild/win32-${process.arch}/esbuild.exe`));
      } catch {
        candidates.push(
          path.join(path.dirname(esbuildEntry), `downloaded-@esbuild-win32-${process.arch}-esbuild.exe`),
        );
      }
    }
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // Missing esbuild remains a dependency/build error rather than a request
    // to search unrelated toolchain directories for another executable.
  }
  const files = await Promise.all(
    [...new Set(candidates)].map(async (file) => {
      return (await regularExecutable(file)) ? file : null;
    }),
  );
  return files.filter(Boolean);
}

async function runtimeExecutables() {
  // Full repair/install also covers the startup children (notably esbuild),
  // while retaining the SDK and virtual-environment checks below.
  const files = await developmentRuntimeExecutables(
    path.join(repository, 'node_modules/electron/dist/electron.exe'),
  );
  // These are installed application runtimes, not user projects or system files.
  const directories = ['node_modules/electron/dist', 'tools', '.tools/esptool-venv'].map((root) =>
    path.join(repository, root),
  );
  // Toolchains contain thousands of nested directories. Bound concurrent reads
  // instead of paying one filesystem round trip per directory in serial.
  while (directories.length) {
    const batch = directories.splice(0, 16);
    await Promise.all(
      batch.map(async (directory) => {
        const info = await lstat(directory).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (!info?.isDirectory() || info.isSymbolicLink()) return;
        for (const item of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, item.name);
          if (item.isSymbolicLink()) continue;
          if (item.isDirectory()) directories.push(file);
          else if (item.isFile() && path.extname(item.name).toLowerCase() === '.exe') files.push(file);
        }
      }),
    );
  }
  return [...new Set(files)].sort();
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
