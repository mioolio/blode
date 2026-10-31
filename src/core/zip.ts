import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
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
export interface FileZipEntry {
  path: string;
  data: { file: string };
  mode?: number;
}
/** UTF-8 ZIP with standard deflate, CRC32 and central directory; intentionally bounded below ZIP64. */
export async function writeZip(
  file: string,
  entries: AsyncIterable<ZipEntry | FileZipEntry>,
  options: { signal?: AbortSignal; maxEntries?: number; maxBytes?: number } = {},
): Promise<number> {
  const handle = await fs.open(file, 'wx');
  const central: Buffer[] = [];
  let offset = 0,
    count = 0;
  const names = new Set<string>();
  const write = async (bytes: Buffer) => {
    await handle.writeFile(bytes);
    offset += bytes.length;
    if (offset > (options.maxBytes ?? 2_000_000_000)) throw new Error('error.packageTooLarge');
  };
  try {
    for await (const entry of entries) {
      options.signal?.throwIfAborted();
      if (
        entry.mode !== undefined &&
        (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0xffff)
      )
        throw new Error('error.invalidArguments');
      if (
        ++count > (options.maxEntries ?? 10000) ||
        entry.path.startsWith('/') ||
        entry.path.split('/').some((part) => part === '..' || part === '.' || !part) ||
        /[\\:\0]/.test(entry.path) ||
        names.has(entry.path.toLowerCase())
      )
        throw new Error('error.packagePathCollision');
      names.add(entry.path.toLowerCase());
      const name = Buffer.from(entry.path, 'utf8');
      if (name.length > 65535) throw new Error('error.invalidPath');
      const streamed = !Buffer.isBuffer(entry.data);
      const originalSize = streamed
        ? (await fs.stat((entry.data as { file: string }).file)).size
        : (entry.data as Buffer).length;
      const data = streamed ? null : deflateRawSync(entry.data as Buffer, { level: 6 });
      let checksum = streamed ? 0 : crc32(entry.data as Buffer);
      const packedSize = data?.length ?? originalSize;
      if (originalSize > (options.maxBytes ?? 1_500_000_000)) throw new Error('error.packageTooLarge');
      const start = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(streamed ? 0x808 : 0x800, 6);
      header.writeUInt16LE(streamed ? 0 : 8, 8);
      header.writeUInt16LE(33, 12);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(streamed ? 0 : packedSize, 18);
      header.writeUInt32LE(streamed ? 0 : originalSize, 22);
      header.writeUInt16LE(name.length, 26);
      await write(header);
      await write(name);
      if (data) await write(data);
      else {
        let crc = 0xffffffff,
          received = 0;
        for await (const chunk of createReadStream((entry.data as { file: string }).file, {
          signal: options.signal,
        })) {
          received += chunk.length;
          if (received > originalSize) throw new Error('error.packageChanged');
          for (const byte of chunk) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
          await write(chunk);
        }
        if (received !== originalSize) throw new Error('error.packageChanged');
        checksum = (crc ^ 0xffffffff) >>> 0;
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50);
        descriptor.writeUInt32LE(checksum, 4);
        descriptor.writeUInt32LE(packedSize, 8);
        descriptor.writeUInt32LE(originalSize, 12);
        await write(descriptor);
      }
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50);
      // Unix extraction tools read the upper external-attributes word as st_mode.
      // Entries are always regular files: never encode symlinks or setuid bits.
      directory.writeUInt16LE(entry.mode === undefined ? 20 : (3 << 8) | 20, 4);
      directory.writeUInt16LE(20, 6);
      directory.writeUInt16LE(streamed ? 0x808 : 0x800, 8);
      directory.writeUInt16LE(streamed ? 0 : 8, 10);
      directory.writeUInt16LE(33, 14);
      directory.writeUInt32LE(checksum, 16);
      directory.writeUInt32LE(packedSize, 20);
      directory.writeUInt32LE(originalSize, 24);
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
