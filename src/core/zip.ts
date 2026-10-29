import { promises as fs } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export interface ZipEntry {
  path: string;
  data: Buffer;
  /** Optional regular-file permissions, normally from fs.stat().mode. */
  mode?: number;
}
/** UTF-8 ZIP with standard deflate, CRC32 and central directory; intentionally bounded below ZIP64. */
export async function writeZip(file: string, entries: AsyncIterable<ZipEntry>): Promise<number> {
  const handle = await fs.open(file, 'wx');
  const central: Buffer[] = [];
  let offset = 0,
    count = 0;
  const names = new Set<string>();
  const write = async (bytes: Buffer) => {
    await handle.writeFile(bytes);
    offset += bytes.length;
    if (offset > 1_000_000_000) throw new Error('error.packageTooLarge');
  };
  try {
    for await (const entry of entries) {
      if (
        entry.mode !== undefined &&
        (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0xffff)
      )
        throw new Error('error.invalidArguments');
      if (
        ++count > 10000 ||
        entry.path.startsWith('/') ||
        entry.path.split('/').some((part) => part === '..' || part === '.' || !part) ||
        /[\\:\0]/.test(entry.path) ||
        names.has(entry.path.toLowerCase())
      )
        throw new Error('error.packagePathCollision');
      names.add(entry.path.toLowerCase());
      const name = Buffer.from(entry.path, 'utf8');
      if (name.length > 65535) throw new Error('error.invalidPath');
      const data = deflateRawSync(entry.data, { level: 6 });
      const checksum = crc32(entry.data);
      const start = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(33, 12);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(entry.data.length, 22);
      header.writeUInt16LE(name.length, 26);
      await write(header);
      await write(name);
      await write(data);
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50);
      // Unix extraction tools read the upper external-attributes word as st_mode.
      // Entries are always regular files: never encode symlinks or setuid bits.
      directory.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
      directory.writeUInt16LE(20, 6);
      directory.writeUInt16LE(0x800, 8);
      directory.writeUInt16LE(8, 10);
      directory.writeUInt16LE(33, 14);
      directory.writeUInt32LE(checksum, 16);
      directory.writeUInt32LE(data.length, 20);
      directory.writeUInt32LE(entry.data.length, 24);
      directory.writeUInt16LE(name.length, 28);
      if (entry.mode !== undefined)
        directory.writeUInt32LE(((0o100000 | (entry.mode & 0o777)) << 16) >>> 0, 38);
      directory.writeUInt32LE(start, 42);
      central.push(directory, name);
    }
    const start = offset;
    for (const bytes of central) await write(bytes);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    await write(end);
    return offset;
  } finally {
    await handle.close();
  }
}
