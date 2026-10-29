import { isUtf8 } from 'node:buffer';

export type OutputEncoding = 'auto' | 'utf8' | 'gb18030' | 'utf16le';

/** Preserve UTF-8 boundaries. On Windows only, invalid UTF-8 can select the native Chinese code page. */
export class OutputDecoder {
  private tail: Buffer = Buffer.alloc(0);
  private decoder?: TextDecoder;
  private initial = true;
  constructor(
    private readonly encoding: OutputEncoding = 'auto',
    private readonly windows = process.platform === 'win32',
  ) {
    if (encoding === 'gb18030' || encoding === 'utf16le')
      this.decoder = new TextDecoder(encoding === 'gb18030' ? 'gb18030' : 'utf-16le');
  }
  write(bytes: Buffer): string {
    const data = this.tail.length ? Buffer.concat([this.tail, bytes]) : bytes;
    this.tail = Buffer.alloc(0);
    if (this.decoder) return this.decoder.decode(data, { stream: true });
    if (this.initial && data.length < 2) {
      this.tail = data;
      return '';
    }
    if (this.initial && this.encoding === 'auto' && data[0] === 0xff && data[1] === 0xfe) {
      this.initial = false;
      this.decoder = new TextDecoder('utf-16le');
      return this.decoder.decode(data, { stream: true });
    }
    this.initial = false;
    let end = data.length;
    for (let back = 1; back <= Math.min(4, data.length); back++) {
      const index = data.length - back,
        byte = data[index];
      if ((byte & 0xc0) === 0x80) continue;
      const expected =
        byte >= 0xc2 && byte <= 0xdf
          ? 2
          : byte >= 0xe0 && byte <= 0xef
            ? 3
            : byte >= 0xf0 && byte <= 0xf4
              ? 4
              : 1;
      if (expected > back) end = index;
      break;
    }
    const complete = data.subarray(0, end);
    if (this.encoding === 'auto' && this.windows && !isUtf8(complete)) {
      this.decoder = new TextDecoder('gb18030');
      return this.decoder.decode(data, { stream: true });
    }
    this.tail = data.subarray(end);
    return complete.toString('utf8').replace(/^\uFEFF/, '');
  }
  end(): string {
    if (this.decoder) return this.decoder.decode();
    const text = this.tail.toString('utf8');
    this.tail = Buffer.alloc(0);
    return text;
  }
}
