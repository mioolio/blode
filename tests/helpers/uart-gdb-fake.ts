import { Duplex } from 'node:stream';
import type { UartGdbSerial } from '../../extensions/boards/Esp32_S3_CAM/debugger/uart-gdb';

export function rsp(body: string | Buffer): Buffer {
  const bytes = Buffer.from(body);
  return Buffer.concat([
    Buffer.from('$'),
    bytes,
    Buffer.from('#' + (bytes.reduce((a, b) => a + b, 0) & 255).toString(16).padStart(2, '0')),
  ]);
}
export class FakeUart extends Duplex implements UartGdbSerial {
  isOpen = false;
  writes: Buffer[] = [];
  closeCount = 0;
  openDelay = 0;
  closeDelay = 0;
  onWrite?: (bytes: Buffer) => void;
  open(callback: (error?: Error | null) => void) {
    setTimeout(() => {
      this.isOpen = true;
      callback();
      this.emit('open');
    }, this.openDelay);
  }
  close(callback: (error?: Error | null) => void) {
    this.closeCount++;
    setTimeout(() => {
      this.isOpen = false;
      callback();
    }, this.closeDelay);
  }
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(Buffer.from(chunk));
    this.onWrite?.(chunk);
    callback();
  }
  receive(bytes: string | Buffer) {
    this.push(Buffer.from(bytes));
  }
}
