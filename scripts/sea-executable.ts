import { promises as fs } from 'node:fs';

/** Remove the original certificate from a Node copy before postject changes PE sections. */
export function unsignedNodeExecutable(input: Buffer): Buffer {
  if (input.length < 64 || input.toString('ascii', 0, 2) !== 'MZ') throw Error('Invalid Node PE header.');
  const pe = input.readUInt32LE(0x3c);
  if (pe + 24 > input.length || input.readUInt32LE(pe) !== 0x4550) throw Error('Invalid Node PE header.');
  const optional = pe + 24;
  const optionalSize = input.readUInt16LE(pe + 20);
  const end = optional + optionalSize;
  if (end > input.length || optionalSize < 2) throw Error('Invalid Node optional header.');
  const magic = input.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw Error('Unsupported Node PE format.');
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const security = directories + 4 * 8;
  if (security + 8 > end || input.readUInt32LE(directories - 4) < 5)
    throw Error('Missing Node PE data directories.');
  const address = input.readUInt32LE(security);
  const size = input.readUInt32LE(security + 4);
  if (!address && !size) return Buffer.from(input);
  const sections = input.readUInt16LE(pe + 6);
  if (end + sections * 40 > input.length) throw Error('Invalid Node section table.');
  let lastSection = end + sections * 40;
  for (let index = 0; index < sections; index++) {
    const section = end + index * 40;
    lastSection = Math.max(lastSection, input.readUInt32LE(section + 20) + input.readUInt32LE(section + 16));
  }
  if (!address || size < 8 || address % 8 || address < lastSection || address + size !== input.length)
    throw Error('Unexpected Node certificate layout; refusing to truncate executable data.');
  const result = Buffer.from(input.subarray(0, address));
  result.fill(0, security, security + 8);
  result.writeUInt32LE(0, optional + 64);
  return result;
}

export async function prepareSeaExecutable(source: string, destination: string) {
  await fs.writeFile(destination, unsignedNodeExecutable(await fs.readFile(source)), { flag: 'wx' });
}
