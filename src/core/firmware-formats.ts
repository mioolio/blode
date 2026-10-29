export type FirmwareFormat = 'bin' | 'hex' | 'srec';
export interface FirmwareSegment {
  address: number;
  data: Buffer;
}
export const MAX_FIRMWARE_BYTES = 64 * 1024 * 1024;

function address(value: number, size = 0): void {
  if (!Number.isSafeInteger(value) || value < 0 || value + size > 0x1_0000_0000)
    throw new Error('firmware.invalidAddress');
}

/** Check before allocating: gaps may be significant, but never imply unbounded memory. */
export function normalizeSegments(input: readonly FirmwareSegment[]): FirmwareSegment[] {
  const sorted = [...input].sort((a, b) => a.address - b.address);
  if (!sorted.length) throw new Error('firmware.emptyImage');
  let bytes = 0;
  const groups: { address: number; size: number; parts: Buffer[] }[] = [];
  for (const segment of sorted) {
    address(segment.address, segment.data.length);
    if (!segment.data.length) throw new Error('firmware.emptyImage');
    bytes += segment.data.length;
    if (bytes > MAX_FIRMWARE_BYTES) throw new Error('firmware.imageTooLarge');
    const last = groups.at(-1);
    if (last && segment.address < last.address + last.size) throw new Error('firmware.overlap');
    if (last && segment.address === last.address + last.size) {
      last.parts.push(segment.data);
      last.size += segment.data.length;
    } else groups.push({ address: segment.address, size: segment.data.length, parts: [segment.data] });
  }
  if (groups.at(-1)!.address + groups.at(-1)!.size - groups[0].address > MAX_FIRMWARE_BYTES)
    throw new Error('firmware.sparseTooLarge');
  return groups.map((group) => ({ address: group.address, data: Buffer.concat(group.parts, group.size) }));
}

export function mergeSegments(input: readonly FirmwareSegment[]): FirmwareSegment {
  const segments = normalizeSegments(input);
  const start = segments[0].address;
  const end = segments.at(-1)!.address + segments.at(-1)!.data.length;
  const data = Buffer.alloc(end - start, 0xff);
  for (const segment of segments) segment.data.copy(data, segment.address - start);
  return { address: start, data };
}

function hexBytes(value: string): Buffer {
  if (!/^(?:[a-f\d]{2})+$/i.test(value)) throw new Error('firmware.invalidRecord');
  return Buffer.from(value, 'hex');
}

export function parseIntelHex(text: string): FirmwareSegment[] {
  const segments: FirmwareSegment[] = [];
  let upper = 0,
    ended = false;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (ended || !line.startsWith(':')) throw new Error('firmware.invalidRecord');
    const bytes = hexBytes(line.slice(1));
    if (bytes.length < 5 || bytes[0] + 5 !== bytes.length || bytes.reduce((sum, b) => sum + b, 0) & 255)
      throw new Error('firmware.invalidChecksum');
    const type = bytes[3],
      offset = bytes.readUInt16BE(1),
      data = bytes.subarray(4, -1);
    if (type === 0) {
      if (!data.length) continue;
      if (offset + data.length > 0x10000) throw new Error('firmware.invalidRecord');
      segments.push({ address: upper + offset, data });
    } else if (type === 1 && !data.length && !offset) ended = true;
    else if ((type === 2 || type === 4) && data.length === 2 && !offset)
      upper = data.readUInt16BE() * (type === 2 ? 16 : 65536);
    else if ((type === 3 || type === 5) && data.length === 4 && !offset) {
      /* entry-point metadata */
    } else throw new Error('firmware.invalidRecord');
  }
  if (!ended) throw new Error('firmware.missingEndRecord');
  return normalizeSegments(segments);
}

function hexRecord(type: number, offset: number, data: Buffer): string {
  const bytes = Buffer.alloc(4 + data.length);
  bytes[0] = data.length;
  bytes.writeUInt16BE(offset, 1);
  bytes[3] = type;
  data.copy(bytes, 4);
  const sum = -bytes.reduce((total, b) => total + b, 0) & 255;
  return ':' + bytes.toString('hex').toUpperCase() + sum.toString(16).padStart(2, '0').toUpperCase();
}

export function encodeIntelHex(input: readonly FirmwareSegment[]): string {
  const lines: string[] = [];
  let upper = -1;
  for (const segment of normalizeSegments(input))
    for (let offset = 0; offset < segment.data.length;) {
      const current = segment.address + offset;
      const nextUpper = Math.floor(current / 65536);
      if (nextUpper !== upper) {
        const value = Buffer.alloc(2);
        value.writeUInt16BE(nextUpper);
        lines.push(hexRecord(4, 0, value));
        upper = nextUpper;
      }
      const length = Math.min(16, segment.data.length - offset, 65536 - (current % 65536));
      lines.push(hexRecord(0, current % 65536, segment.data.subarray(offset, offset + length)));
      offset += length;
    }
  lines.push(hexRecord(1, 0, Buffer.alloc(0)));
  return lines.join('\r\n') + '\r\n';
}

export function parseSRecord(text: string): FirmwareSegment[] {
  const segments: FirmwareSegment[] = [];
  let ended = false,
    count = 0;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (ended || !/^S[012356789]/.test(line)) throw new Error('firmware.invalidRecord');
    const type = Number(line[1]),
      bytes = hexBytes(line.slice(2));
    if (bytes[0] + 1 !== bytes.length || (bytes.reduce((total, b) => total + b, 0) & 255) !== 255)
      throw new Error('firmware.invalidChecksum');
    const widths: Record<number, number> = { 0: 2, 1: 2, 2: 3, 3: 4, 5: 2, 6: 3, 7: 4, 8: 3, 9: 2 };
    const width = widths[type];
    if (bytes.length < width + 2) throw new Error('firmware.invalidRecord');
    const start = bytes.readUIntBE(1, width),
      data = bytes.subarray(width + 1, -1);
    if (type >= 1 && type <= 3) {
      if (data.length) segments.push({ address: start, data });
      count++;
    } else if (type === 5 || type === 6) {
      if (data.length || start !== count) throw new Error('firmware.invalidRecord');
    } else if (type >= 7) {
      if (data.length) throw new Error('firmware.invalidRecord');
      ended = true;
    }
  }
  if (!ended) throw new Error('firmware.missingEndRecord');
  return normalizeSegments(segments);
}

function sRecord(type: number, start: number, width: number, data: Buffer): string {
  const bytes = Buffer.alloc(width + data.length + 1);
  bytes[0] = width + data.length + 1;
  bytes.writeUIntBE(start, 1, width);
  data.copy(bytes, width + 1);
  return (
    'S' +
    type +
    bytes.toString('hex').toUpperCase() +
    (~bytes.reduce((sum, b) => sum + b, 0) & 255).toString(16).padStart(2, '0').toUpperCase()
  );
}

export function encodeSRecord(input: readonly FirmwareSegment[]): string {
  const segments = normalizeSegments(input),
    lines = [sRecord(0, 0, 2, Buffer.from('Blode'))];
  let count = 0;
  for (const segment of segments)
    for (let i = 0; i < segment.data.length; i += 32) {
      lines.push(sRecord(3, segment.address + i, 4, segment.data.subarray(i, i + 32)));
      count++;
    }
  if (count <= 65535) lines.push(sRecord(5, count, 2, Buffer.alloc(0)));
  else if (count <= 0xffffff) lines.push(sRecord(6, count, 3, Buffer.alloc(0)));
  lines.push(sRecord(7, segments[0].address, 4, Buffer.alloc(0)));
  return lines.join('\r\n') + '\r\n';
}
