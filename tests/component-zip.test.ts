import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readComponentZip } from '../src/core/component-zip';
import { crc32 } from '../src/core/zip';

interface Item {
  name: string;
  content?: string;
  method?: number;
  flags?: number;
  mode?: number;
  extra?: Buffer;
  descriptor?: boolean;
}
function zip(items: Item[]) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const body = Buffer.from(item.content ?? ''),
      name = Buffer.from(item.name),
      extra = item.extra ?? Buffer.alloc(0);
    const method = item.method ?? 8,
      flags = item.flags ?? 0x800 | (item.descriptor ? 8 : 0);
    const data = method === 8 ? deflateRawSync(body) : body,
      crc = crc32(body);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(body.length, 22);
    }
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(((item.mode ?? (item.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    const descriptor = item.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (item.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(body.length, 12);
    }
    locals.push(local, name, extra, data, descriptor);
    centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const centralOffset = (bytes: Buffer) => bytes.readUInt32LE(bytes.length - 6);
const reject = (bytes: Buffer) => assert.throws(() => readComponentZip(bytes), /error.componentArchive/);

test('reads stored and deflated component files, directory records and streaming descriptors', () => {
  const entries = readComponentZip(
    zip([
      { name: '库/', method: 0 },
      { name: '库/main.h', method: 0, content: '#pragma once' },
      { name: '库/main.cpp', content: 'int helper() { return 1; }', descriptor: true },
      { name: 'empty.h' },
    ]),
  );
  assert.deepEqual([...entries.keys()], ['库/main.h', '库/main.cpp', 'empty.h']);
  assert.equal(entries.get('库/main.h')?.toString(), '#pragma once');
  assert.equal(entries.get('库/main.cpp')?.toString(), 'int helper() { return 1; }');
  assert.equal(entries.get('empty.h')?.length, 0);
});

test('rejects traversal, Windows aliases, unsafe directory entries and absolute paths', () => {
  for (const name of [
    '../main.c',
    '/main.c',
    'C:/main.c',
    '\\\\host\\share',
    'a\\b.c',
    'a//b.c',
    './x',
    'NUL',
    'COM1.h',
    'LPT¹.txt',
    'dir/CON.',
    'file ',
    'dir./file',
    'x\0.c',
    'dir/../',
    '/',
  ])
    reject(zip([{ name }]));
});

test('rejects case collisions and file/directory ancestor conflicts in either order', () => {
  for (const names of [
    ['A.h', 'a.h'],
    ['file', 'file/'],
    ['dir', 'dir/x.h'],
    ['dir/x.h', 'dir'],
    ['Dir/a.h', 'dir/b.h'],
    ['x/', 'x/'],
  ])
    reject(zip(names.map((name) => ({ name }))));
  assert.equal(readComponentZip(zip([{ name: 'dir/a.h' }, { name: 'dir/' }])).size, 1);
});

test('rejects Unix links and special files, encryption, unsupported compression and ZIP64 extras', () => {
  for (const mode of [0o120777, 0o010644, 0o060644]) reject(zip([{ name: 'link', mode }]));
  reject(zip([{ name: 'file', flags: 0x801 }]));
  reject(zip([{ name: 'file', flags: 0x840 }]));
  reject(zip([{ name: 'file', method: 12 }]));
  reject(zip([{ name: 'file', extra: Buffer.from([1, 0, 0, 0]) }]));
  reject(zip([{ name: 'file', mode: 0o40755 }]));
  reject(zip([{ name: 'dir/', mode: 0o100644 }]));
});

test('rejects differing local headers, corrupted CRC, compressed payloads and descriptors', () => {
  for (const mutate of [
    (bytes: Buffer) => bytes.writeUInt16LE(0, 8),
    (bytes: Buffer) => bytes.writeUInt16LE(0, 6),
    (bytes: Buffer) => bytes.writeUInt32LE(1, 14),
    (bytes: Buffer) => bytes.writeUInt32LE(1, 22),
    (bytes: Buffer) => bytes.writeUInt8(120, 30),
    (bytes: Buffer) => bytes.writeUInt8(0xff, 35),
  ]) {
    const bytes = zip([{ name: 'a.cpp', content: 'int main() {}' }]);
    mutate(bytes);
    reject(bytes);
  }
  const badCrc = zip([{ name: 'a', method: 0, content: 'data' }]);
  badCrc[31] ^= 1;
  reject(badCrc);
  const badDescriptor = zip([{ name: 'a', descriptor: true, content: 'data' }]);
  badDescriptor[centralOffset(badDescriptor) - 12] ^= 1;
  reject(badDescriptor);
});

test('rejects overlapping local entries, central offsets, disk splits, truncation and trailing payload', () => {
  const overlap = zip([{ name: 'a' }, { name: 'b' }]);
  overlap.writeUInt32LE(0, centralOffset(overlap) + 47 + 42);
  reject(overlap);
  const disks = zip([{ name: 'a' }]);
  disks.writeUInt16LE(1, disks.length - 18);
  reject(disks);
  const offset = zip([{ name: 'a' }]);
  offset.writeUInt32LE(0xffffffff, offset.length - 6);
  reject(offset);
  const file = zip([{ name: 'a', content: 'data' }]);
  reject(file.subarray(0, file.length - 1));
  reject(Buffer.concat([file, Buffer.from('junk')]));
});

test('enforces archive, single-file, total expanded and entry count limits before inflation', () => {
  assert.throws(() => readComponentZip(Buffer.alloc(64 * 1024 * 1024 + 1)), /componentTooLarge/);
  const huge = zip([{ name: 'a' }]);
  huge.writeUInt32LE(64 * 1024 * 1024 + 1, centralOffset(huge) + 24);
  assert.throws(() => readComponentZip(huge), /componentTooLarge/);
  const count = zip([]);
  count.writeUInt16LE(10001, 8);
  count.writeUInt16LE(10001, 10);
  assert.throws(() => readComponentZip(count), /componentTooLarge/);
  assert.throws(() => readComponentZip(zip([{ name: 'x/'.repeat(65) + 'a.h' }])), /componentTooLarge/);
  const total = zip(Array.from({ length: 5 }, (_, index) => ({ name: String(index), descriptor: true })));
  let directory = centralOffset(total);
  for (let i = 0; i < 5; i++) {
    total.writeUInt32LE(64 * 1024 * 1024, directory + 24);
    const local = total.readUInt32LE(directory + 42),
      compressed = total.readUInt32LE(directory + 20);
    total.writeUInt32LE(64 * 1024 * 1024, local + 30 + 1 + compressed + 12);
    directory += 47;
  }
  assert.throws(() => readComponentZip(total), /componentTooLarge/);
  // A lying small declared length cannot make inflation allocate the full expanded stream.
  const bomb = zip([{ name: 'a', content: 'x'.repeat(2 * 1024 * 1024) }]);
  bomb.writeUInt32LE(1, 22);
  bomb.writeUInt32LE(1, centralOffset(bomb) + 24);
  reject(bomb);
});

test('legacy CP437 filenames decode consistently and invalid UTF-8 is rejected', () => {
  const legacy = zip([{ name: 'a.h', flags: 0, content: 'header' }]);
  legacy[30] = 0x82;
  legacy[centralOffset(legacy) + 46] = 0x82;
  assert.equal(readComponentZip(legacy).get('é.h')?.toString(), 'header');
  legacy.writeUInt16LE(0x800, 6);
  legacy.writeUInt16LE(0x800, centralOffset(legacy) + 8);
  reject(legacy);
});
