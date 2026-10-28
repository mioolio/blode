import { SerialPort } from 'serialport';
import type { PortInfo } from '../shared/contracts';

export class SerialConnection {
  private connection: SerialPort | null = null;
  constructor(
    private readonly onData: (data: string) => void,
    private readonly onError: (error: Error) => void,
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
  async open(port: string, baudRate: number): Promise<void> {
    await this.close();
    const connection = new SerialPort({ path: port, baudRate, autoOpen: false });
    this.connection = connection;
    connection.on('data', (data: Buffer) => this.onData(data.toString('utf8')));
    connection.on('error', this.onError);
    connection.on('close', () => {
      if (this.connection === connection) this.connection = null;
    });
    await new Promise<void>((resolve, reject) =>
      connection.open((error) => (error ? reject(error) : resolve())),
    );
  }
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection?.isOpen)
      await new Promise<void>((resolve, reject) =>
        connection.close((error) => (error ? reject(error) : resolve())),
      );
  }
  async write(data: string): Promise<void> {
    const connection = this.connection;
    if (!connection?.isOpen) throw new Error('error.serialClosed');
    if (typeof data !== 'string' || Buffer.byteLength(data) > 64_000) throw new Error('error.serialPayload');
    await new Promise<void>((resolve, reject) =>
      connection.write(data, (error) =>
        error ? reject(error) : connection.drain((error) => (error ? reject(error) : resolve())),
      ),
    );
  }
}
