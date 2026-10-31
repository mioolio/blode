import os from 'node:os';
import path from 'node:path';

/**
 * Default data directory shared by the standalone Web host and the packaged
 * Web launcher. Both processes must resolve the same directory before either
 * creates the runtime cache, so the rule lives here instead of being copied.
 */
export function defaultWebDataRoot(): string {
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Blode Studio Web',
    );
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Blode Studio Web');
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'blode-studio-web',
  );
}
