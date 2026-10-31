import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Windows checkouts on hardened or sandboxed build machines can carry a Low
 * integrity label (`Mandatory Label\Low Mandatory Level`). Executables inherit
 * that label and then run with a low token, which cannot write the user's
 * `%LOCALAPPDATA%`; a double-clicked Web launcher would exit before printing
 * its link. Raising the produced artifact (not the source tree) to Medium is
 * idempotent and safe for ordinary checkouts, where the label is already
 * Medium.
 *
 * @param {string} file
 * @returns {Promise<{ applied: boolean; reason?: string }>}
 */
export async function restoreMediumIntegrity(file) {
  if (process.platform !== 'win32') return { applied: false, reason: 'not-windows' };
  try {
    await execute('icacls', [file, '/setintegritylevel', 'Medium'], {
      windowsHide: true,
      timeout: 30_000,
    });
    return { applied: true };
  } catch (error) {
    return { applied: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
