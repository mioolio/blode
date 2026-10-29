import { SerialPort } from 'serialport';
import { StringDecoder } from 'node:string_decoder';
import type { PortInfo, SerialOptions } from '../shared/contracts';

const defaultOptions: Required<SerialOptions> = {
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
};

/** Defaults are conventional 8N1; reject invalid settings before closing an existing connection. */
export function validateSerialOptions(options: SerialOptions = {}): Required<SerialOptions> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !['dataBits', 'parity', 'stopBits', 'flowControl'].includes(key))
  )
    throw new Error('error.serialOptions');
  const settings = { ...defaultOptions, ...options };
  if (
    ![5, 6, 7, 8].includes(settings.dataBits) ||
    ![1, 1.5, 2].includes(settings.stopBits) ||
    !['none', 'even', 'odd', 'mark', 'space'].includes(settings.parity) ||
    !['none', 'rtscts', 'xonxoff'].includes(settings.flowControl)
  )
    throw new Error('error.serialOptions');
  return settings;
}

export function serialPayload(data: string, encoding: 'utf8' | 'hex' = 'utf8'): Buffer {
  if (typeof data !== 'string' || Buffer.byteLength(data) > 192_000) throw new Error('error.serialPayload');
  let bytes: Buffer;
  if (encoding === 'hex') {
    const text = data.replace(/\s+/g, '');
    if (!text || text.length % 2 || !/^[a-fA-F0-9]+$/.test(text)) throw new Error('error.serialHexPayload');
    bytes = Buffer.from(text, 'hex');
  } else if (encoding === 'utf8') bytes = Buffer.from(data, 'utf8');
  else throw new Error('error.serialPayload');
  if (bytes.length > 64_000) throw new Error('error.serialPayload');
  return bytes;
}

export class SerialConnection {
  private connection: SerialPort | null = null;
  private activeOptions: Required<SerialOptions> = { ...defaultOptions };
  constructor(
    private readonly onData: (data: string) => void,
    private readonly onError: (error: Error) => void,
    private readonly onState: (open: boolean) => void = () => {},
    private readonly createPort: (
      port: string,
      baudRate: number,
      options: Required<SerialOptions>,
    ) => SerialPort = (port, baudRate, options) =>
      new SerialPort({
        path: port,
        baudRate,
        autoOpen: false,
        dataBits: options.dataBits,
        parity: options.parity,
        stopBits: options.stopBits,
        rtscts: options.flowControl === 'rtscts',
        xon: options.flowControl === 'xonxoff',
        xoff: options.flowControl === 'xonxoff',
      }),
  ) {}
  static async list(): Promise<PortInfo[]> {
    return (await SerialPort.list()).map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer,
      vendorId: port.vendorId,
      productId: port.productId,
      serialNumber: port.serialNumber,
    }));
  }
  get isOpen(): boolean {
    return !!this.connection?.isOpen;
  }
  get state(): { open: boolean; port: string; baudRate: number; options?: SerialOptions } {
    const connection = this.connection;
    return connection?.isOpen
      ? {
          open: true,
          port: connection.path,
          baudRate: connection.baudRate,
          options: { ...this.activeOptions },
        }
      : { open: false, port: '', baudRate: 0 };
  }
  async open(port: string, baudRate: number, options: SerialOptions = {}): Promise<void> {
    const settings = validateSerialOptions(options);
    if (!Number.isInteger(baudRate) || baudRate < 110 || baudRate > 4_000_000)
      throw new Error('error.invalidBaudRate');
    await this.close();
    const connection = this.createPort(port, baudRate, settings);
    this.activeOptions = settings;
    this.connection = connection;
    const decoder = new StringDecoder('utf8');
    connection.on('data', (data: Buffer) => {
      if (this.connection !== connection) return;
      const text = decoder.write(data);
      if (text) this.onData(text);
    });
    connection.on('error', this.onError);
    connection.on('close', () => {
      if (this.connection === connection) {
        const tail = decoder.end();
        if (tail) this.onData(tail);
        this.connection = null;
        this.onState(false);
      }
    });
    try {
      await new Promise<void>((resolve, reject) =>
        connection.open((error) => (error ? reject(error) : resolve())),
      );
      this.onState(true);
    } catch (error) {
      if (this.connection === connection) this.connection = null;
      this.onState(false);
      throw error;
    }
  }
  async close(): Promise<void> {
    const connection = this.connection;
    if (connection?.isOpen) {
      await new Promise<void>((resolve, reject) =>
        connection.close((error) => (error ? reject(error) : resolve())),
      );
      if (this.connection === connection) {
        this.connection = null;
        this.onState(false);
      }
    } else if (connection) {
      this.connection = null;
      connection.destroy();
    }
  }
  async write(data: string, encoding: 'utf8' | 'hex' = 'utf8'): Promise<void> {
    const connection = this.connection;
    if (!connection?.isOpen) throw new Error('error.serialClosed');
    const bytes = serialPayload(data, encoding);
    await new Promise<void>((resolve, reject) =>
      connection.write(bytes, (error) =>
        error ? reject(error) : connection.drain((error) => (error ? reject(error) : resolve())),
      ),
    );
  }
}
