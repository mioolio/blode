import { inflateRawSync } from 'node:zlib';
import { crc32 } from './zip';

const cp437 = [
  ...'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
];
export interface ZipReadLimits {
  maxArchive?: number;
  maxFile?: number;
  maxTotal?: number;
  maxEntries?: number;
  maxPathLength?: number;
  invalidError?: string;
  tooLargeError?: string;
}
interface Entry {
  name: string;
  directory: boolean;
  dataStart: number;
  dataEnd: number;
  compressed: number;
  size: number;
  crc: number;
  method: number;
  localStart: number;
  localEnd: number;
}
const DEFAULTS = {
  maxArchive: 64 * 1024 * 1024,
  maxFile: 64 * 1024 * 1024,
  maxTotal: 256 * 1024 * 1024,
  maxEntries: 10000,
  maxPathLength: 4096,
  invalidError: 'error.componentArchive',
  tooLargeError: 'error.componentTooLarge',
};

/**
 * Bounded, path-safe ZIP reader shared by component imports and managed tools.
 * Only stored and deflated entries are accepted; no path is created or executed.
 */
export function readZip(bytes: Buffer, options: ZipReadLimits = {}): Map<string, Buffer> {
  const limits = { ...DEFAULTS, ...options };
  const invalid = (): never => {
    throw new Error(limits.invalidError);
  };
  const tooLarge = (): never => {
    throw new Error(limits.tooLargeError);
  };
  const decode = (value: Buffer, utf8: boolean): string => {
    if (!utf8)
      return [...value].map((byte) => (byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128])).join('');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      return invalid();
    }
  };
  const validateName = (name: string) => {
    const directory = name.endsWith('/');
    const relative = directory ? name.slice(0, -1) : name;
    if (relative.split('/').length > 64) tooLarge();
    if (
      !relative ||
      relative.length > limits.maxPathLength ||
      relative
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[\\<>:"|?*\x00-\x1f\x7f]/.test(part) ||
            /[. ]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
        )
    )
      invalid();
    return { relative, directory };
  };
  if (bytes.length > limits.maxArchive) tooLarge();
  if (bytes.length < 22) invalid();
  const range = (start: number, size: number, end = bytes.length) => {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(size) ||
      start < 0 ||
      size < 0 ||
      start + size > end
    )
      invalid();
  };
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--)
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  if (end < 0) invalid();
  const count = bytes.readUInt16LE(end + 10),
    directorySize = bytes.readUInt32LE(end + 12),
    directoryStart = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryStart === 0xffffffff ||
    directoryStart + directorySize !== end
  )
    invalid();
  if (count > limits.maxEntries) tooLarge();
  const extras = (start: number, length: number) => {
    range(start, length);
    const limit = start + length;
    while (start < limit) {
      range(start, 4, limit);
      const id = bytes.readUInt16LE(start),
        size = bytes.readUInt16LE(start + 2);
      if (id === 0x0001) invalid(); // ZIP64, even when 32-bit fields happen to fit.
      range(start + 4, size, limit);
      start += 4 + size;
    }
  };
  const names = new Map<string, { spelling: string; directory: boolean; explicit: boolean }>();
  let pathCharacters = 0;
  const register = (name: string, directory: boolean) => {
    const parts = name.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const spelling = parts.slice(0, index).join('/'),
        key = spelling.toLowerCase(),
        isDirectory = index < parts.length || directory,
        explicit = index === parts.length;
      const previous = names.get(key);
      if (previous) {
        if (
          previous.spelling !== spelling ||
          previous.directory !== isDirectory ||
          (explicit && previous.explicit)
        )
          invalid();
        if (explicit) previous.explicit = true;
      } else {
        if (names.size >= limits.maxEntries * 2 || (pathCharacters += spelling.length) > 4_000_000)
          tooLarge();
        names.set(key, { spelling, directory: isDirectory, explicit });
      }
    }
  };
  const entries: Entry[] = [];
  let cursor = directoryStart,
    total = 0;
  for (let index = 0; index < count; index++) {
    range(cursor, 46, end);
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const version = bytes.readUInt16LE(cursor + 6),
      flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20),
      size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28),
      extraSize = bytes.readUInt16LE(cursor + 30),
      commentSize = bytes.readUInt16LE(cursor + 32);
    const attributes = bytes.readUInt32LE(cursor + 38),
      localStart = bytes.readUInt32LE(cursor + 42);
    if (
      version > 20 ||
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      (method === 0 && flags & 6) ||
      bytes.readUInt16LE(cursor + 34) ||
      compressed === 0xffffffff ||
      size === 0xffffffff ||
      localStart === 0xffffffff
    )
      invalid();
    if (size > limits.maxFile || (total += size) > limits.maxTotal) tooLarge();
    range(cursor + 46, nameSize + extraSize + commentSize, end);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const { relative: name, directory } = validateName(decode(nameBytes, !!(flags & 0x800)));
    const unixType = (attributes >>> 16) & 0xf000;
    if (
      (unixType && unixType !== 0x8000 && unixType !== 0x4000) ||
      (unixType === 0x8000 && directory) ||
      (unixType === 0x4000 && !directory) ||
      (attributes & 0x10 && !directory) ||
      (directory && size !== 0)
    )
      invalid();
    register(name, directory);
    extras(cursor + 46 + nameSize, extraSize);
    range(localStart, 30, directoryStart);
    if (
      bytes.readUInt32LE(localStart) !== 0x04034b50 ||
      bytes.readUInt16LE(localStart + 4) !== version ||
      bytes.readUInt16LE(localStart + 6) !== flags ||
      bytes.readUInt16LE(localStart + 8) !== method ||
      bytes.readUInt32LE(localStart + 10) !== bytes.readUInt32LE(cursor + 12)
    )
      invalid();
    const localName = bytes.readUInt16LE(localStart + 26),
      localExtra = bytes.readUInt16LE(localStart + 28);
    range(localStart + 30, localName + localExtra, directoryStart);
    if (
      localName !== nameSize ||
      !bytes.subarray(localStart + 30, localStart + 30 + localName).equals(nameBytes)
    )
      invalid();
    extras(localStart + 30 + localName, localExtra);
    for (const [localOffset, value] of [
      [14, crc],
      [18, compressed],
      [22, size],
    ]) {
      const localValue = bytes.readUInt32LE(localStart + localOffset);
      if (localValue !== value && (!(flags & 8) || localValue !== 0)) invalid();
    }
    const dataStart = localStart + 30 + localName + localExtra,
      dataEnd = dataStart + compressed;
    range(dataStart, compressed, directoryStart);
    let localEnd = dataEnd;
    if (flags & 8) {
      range(localEnd, 12, directoryStart);
      if (bytes.readUInt32LE(localEnd) === 0x08074b50) localEnd += 4;
      range(localEnd, 12, directoryStart);
      if (
        bytes.readUInt32LE(localEnd) !== crc ||
        bytes.readUInt32LE(localEnd + 4) !== compressed ||
        bytes.readUInt32LE(localEnd + 8) !== size
      )
        invalid();
      localEnd += 12;
    }
    entries.push({ name, directory, dataStart, dataEnd, compressed, size, crc, method, localStart, localEnd });
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) invalid();
  let localCursor = 0;
  for (const entry of [...entries].sort((a, b) => a.localStart - b.localStart)) {
    if (entry.localStart !== localCursor) invalid(); // Overlaps, prefixes and unexplained payloads.
    localCursor = entry.localEnd;
  }
  if (localCursor !== directoryStart) invalid();
  const result = new Map<string, Buffer>();
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.dataStart, entry.dataEnd);
    let data: Buffer;
    if (entry.method === 0) data = Buffer.from(compressed);
    else {
      try {
        const decoded = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, entry.size),
          info: true,
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (decoded.engine.bytesWritten !== entry.compressed) invalid();
        data = decoded.buffer;
      } catch {
        return invalid();
      }
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc) invalid();
    if (!entry.directory) result.set(entry.name, data);
  }
  return result;
}
