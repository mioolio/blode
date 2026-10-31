import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function buildDeviceModules(output) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'scripts/build-device-modules.ts', path.resolve(output)],
    {
      cwd: root,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
}
