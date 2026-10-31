import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { packageRuntime } from './package-runtime';

const repository = fileURLToPath(new URL('..', import.meta.url));
/** Build standalone modules once, alongside the host, never inside the shipped runtime. */
export async function buildDeviceModules(output: string) {
  const parent = path.resolve(output);
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, 'device-modules-stage-'));
  const destination = path.join(parent, 'device-modules');
  try {
    await Promise.all(
      ['Esp32_S3_CAM', 'STM32F103C8T6'].map((id) =>
        packageRuntime({
          source: path.join(repository, 'extensions', 'boards', id),
          output: stage,
        }),
      ),
    );
    // Both targets are fixed children of the caller's output directory.
    if (path.dirname(destination) !== parent || path.dirname(stage) !== parent)
      throw new Error('Unsafe device module output.');
    await fs.rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    // Windows scanners can briefly retain newly compiled module files.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(stage, destination);
        break;
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          attempt >= 4 ||
          !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        await delay(150 * (attempt + 1));
      }
    }
  } finally {
    if (path.dirname(stage) === parent && path.basename(stage).startsWith('device-modules-stage-'))
      await fs.rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildDeviceModules(process.argv[2] || path.join(repository, 'dist'));
