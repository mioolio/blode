import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { probeLogFilename, validateProbeLog } from '../shared/probe-log';

async function canWrite(directory: string): Promise<boolean> {
  const probe = path.join(directory, `.blode-export-probe-${randomBytes(8).toString('hex')}`);
  let created = false;
  try {
    await fs.writeFile(probe, '', { flag: 'wx' });
    created = true;
    await fs.unlink(probe);
    return true;
  } catch {
    if (created) await fs.unlink(probe).catch(() => {});
    return false;
  }
}

/** Only a native save dialog supplies the destination; renderer IPC cannot supply a path. */
export async function exportProbeLog(options: {
  content: string;
  projectRoot: string;
  dataRoot: string;
  choosePath(defaultPath: string): Promise<string | undefined>;
}): Promise<'saved' | 'cancelled'> {
  validateProbeLog(options.content);
  let directory = options.projectRoot;
  if (!directory || !(await canWrite(directory))) {
    directory = path.join(options.dataRoot, 'exports');
    await fs.mkdir(directory, { recursive: true });
    if (!(await canWrite(directory))) throw new Error('error.logExportDirectory');
  }
  const destination = await options.choosePath(path.join(directory, probeLogFilename()));
  if (!destination) return 'cancelled';
  await fs.writeFile(destination, options.content, 'utf8');
  return 'saved';
}
