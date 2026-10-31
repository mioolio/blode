import { readZip } from './zip-reader';

const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ENTRIES = 10000;

/** Component ZIP limits keep imports small; shared parsing lives in zip-reader.ts. */
export function readComponentZip(bytes: Buffer, limits: { maxArchive?: number } = {}): Map<string, Buffer> {
  return readZip(bytes, {
    maxArchive: limits.maxArchive ?? MAX_ARCHIVE,
    maxFile: MAX_FILE,
    maxTotal: MAX_TOTAL,
    maxEntries: MAX_ENTRIES,
    invalidError: 'error.componentArchive',
    tooLargeError: 'error.componentTooLarge',
  });
}
