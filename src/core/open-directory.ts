import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCommand } from './process';

export interface OpenDirectoryOptions {
  nativeOpenPath?: (directory: string) => Promise<string>;
  runner?: typeof runCommand;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Open an interactive shell folder; never manage Explorer as a compiler process. */
export async function openHostDirectory(
  directory: string,
  options: OpenDirectoryOptions = {},
): Promise<void> {
  if (!path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error('error.invalidPath');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('error.runtimePluginPath');
  if (options.nativeOpenPath) {
    const error = await options.nativeOpenPath(directory);
    if (error) throw new Error('error.openLocationFailed', { cause: error });
    return;
  }
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runCommand;
  // The headless Node host has no Electron shell. ShellExecute opens the folder
  // independently, so the short helper cannot hide or time out Explorer itself.
  const result =
    platform === 'win32'
      ? await runner(
          path.join(
            options.env?.SystemRoot || process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$ErrorActionPreference="Stop"; $info=[System.Diagnostics.ProcessStartInfo]::new(); $info.FileName=$env:BLODE_DIRECTORY_TO_OPEN; $info.UseShellExecute=$true; [void][System.Diagnostics.Process]::Start($info)',
          ],
          { timeout: 10000, env: { ...options.env, BLODE_DIRECTORY_TO_OPEN: directory } },
        )
      : await runner(platform === 'darwin' ? 'open' : 'xdg-open', [directory], {
          timeout: 10000,
          env: options.env,
        });
  if (result.code !== 0) throw new Error('error.openLocationFailed', { cause: result.output });
}
