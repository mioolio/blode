import type { DebugProbeInfo } from '../../../src/shared/contracts.js';

export const STM32_FLASH_BASE = 0x08000000;
export const STM32_MAX_FLASH_SIZE = 8 * 1024 * 1024;

export function validateStlinkSerial(serialNumber: string): void {
  if (!/^[a-f0-9]{8,64}$/i.test(serialNumber)) throw new Error('errors.invalidProbeSerial');
}

export function validateSwdFrequency(frequencyKhz: number): void {
  if (!Number.isInteger(frequencyKhz) || frequencyKhz < 5 || frequencyKhz > 4000)
    throw new Error('errors.invalidSwdFrequency');
}

export function isStm32FlashSize(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= STM32_MAX_FLASH_SIZE && size % 4 === 0;
}

/** --hot-plug avoids reset; enumeration never chooses the first attached probe implicitly. */
export function buildStlinkProbeArgs(frequencyKhz = 1800): string[] {
  validateSwdFrequency(frequencyKhz);
  return ['--hot-plug', '--probe', `--freq=${frequencyKhz}`];
}

/** st-flash write verifies the written bytes internally and fails on readback mismatch. */
export function buildStlinkFlashArgs(options: {
  serialNumber: string;
  frequencyKhz: number;
  file: string;
  address: number;
  size: number;
  flashSize: number;
}): string[] {
  const { serialNumber, frequencyKhz, file, address, size, flashSize } = options;
  validateStlinkSerial(serialNumber);
  validateSwdFrequency(frequencyKhz);
  if (!file || file.startsWith('-') || /[\r\n\0]/.test(file)) throw new Error('errors.invalidFirmwarePath');
  if (!isStm32FlashSize(flashSize)) throw new Error('errors.unsupportedFlashSize');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('errors.invalidFirmwareSize');
  if (!Number.isSafeInteger(address) || address < STM32_FLASH_BASE || address % 4 !== 0)
    throw new Error('errors.invalidFlashOffset');
  // stlink pads a final partial word. Include that padding in the capacity check.
  if (address - STM32_FLASH_BASE + Math.ceil(size / 4) * 4 > flashSize)
    throw new Error('errors.firmwareOutOfBounds');
  return [
    '--serial',
    serialNumber,
    '--freq',
    String(frequencyKhz),
    '--hot-plug',
    '--format',
    'binary',
    'write',
    file,
    `0x${address.toString(16)}`,
  ];
}

/** st-info reports flash/SRAM in bytes, including when multiple numbered probes are present. */
export function parseStlinkProbes(output: string): DebugProbeInfo[] {
  const starts = [...output.matchAll(/^[\t ]*serial[\t ]*:[\t ]*([a-f0-9]{8,64})[\t ]*\r?$/gim)];
  const devices: DebugProbeInfo[] = [];
  for (let index = 0; index < starts.length; index++) {
    const serialNumber = starts[index]![1]!;
    const block = output.slice(starts[index]!.index, starts[index + 1]?.index);
    // The next probe's version can appear at the tail of this block; it does not
    // describe this target, so names stay stable and use the serial for identity.
    const description = /^\s*(?:dev-type|descr|description)\s*:\s*(.+)$/im.exec(block)?.[1]?.trim();
    const chip = /^\s*chipid\s*:\s*(0x[\da-f]+)\s*$/im.exec(block)?.[1];
    const flash = /^\s*flash\s*:\s*(\d+)(?:\s|$)/im.exec(block)?.[1];
    const ram = /^\s*sram\s*:\s*(\d+)\s*$/im.exec(block)?.[1];
    const chipNumber = chip ? Number.parseInt(chip, 16) : 0;
    const device: DebugProbeInfo = {
      serialNumber,
      name: `ST-Link ${serialNumber}`,
      ...(chipNumber > 0 && chipNumber <= 0xffff ? { chipId: `0x${chipNumber.toString(16)}` } : {}),
      ...(description ? { description } : {}),
      ...(flash && isStm32FlashSize(Number(flash)) ? { flashSize: Number(flash) } : {}),
      ...(ram && Number.isSafeInteger(Number(ram)) && Number(ram) > 0 ? { ramSize: Number(ram) } : {}),
    };
    if (devices.some((entry) => entry.serialNumber.toLowerCase() === serialNumber.toLowerCase()))
      throw new Error('errors.invalidProbeSerial');
    devices.push(device);
  }
  return devices;
}
