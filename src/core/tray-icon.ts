import { deflateSync } from 'node:zlib';
import { crc32 } from './zip';

/** A small opaque chip glyph stays legible in Windows light and dark notification areas. */
export function createTrayIcon(): Buffer {
  const size = 32;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const body = x >= 6 && x < 26 && y >= 6 && y < 26;
      const pin =
        (((x >= 3 && x < 6) || (x >= 26 && x < 29)) && [9, 14, 19, 24].some((v) => y >= v && y < v + 2)) ||
        (((y >= 3 && y < 6) || (y >= 26 && y < 29)) && [9, 14, 19, 24].some((v) => x >= v && x < v + 2));
      const letter =
        body &&
        ((x >= 11 && x < 14 && y >= 10 && y < 23) ||
          (((y >= 10 && y < 13) || (y >= 15 && y < 18) || (y >= 20 && y < 23)) && x >= 14 && x < 20) ||
          (x >= 19 && x < 22 && ((y >= 12 && y < 16) || (y >= 17 && y < 21))));
      raw[offset] = letter ? 255 : 37;
      raw[offset + 1] = letter ? 255 : 99;
      raw[offset + 2] = letter ? 255 : 235;
      raw[offset + 3] = body || pin ? 255 : 0;
    }
  const chunk = (type: string, data: Buffer) => {
    const label = Buffer.from(type);
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length);
    label.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([label, data])), 8 + data.length);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
