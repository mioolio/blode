import type { FlashSegment } from '../../../types.js';

// Auto is used for discovery; writes in this package target only ESP32-S3.
const chips = new Set(['auto', 'esp32s3']);

function validateTarget(port: string, chip: string) {
  if (!port.trim() || port.startsWith('-') || /[\r\n\0]/.test(port)) throw new Error('errors.invalidPort');
  if (!chips.has(chip)) throw new Error('errors.unsupportedChip');
}

/** Python module prefix is intentional: callers select a venv/executable, never a shell command. */
export function buildProbeArgs(port: string, chip = 'auto'): string[] {
  validateTarget(port, chip);
  return ['-m', 'esptool', '--chip', chip, '--port', port, '--baud', '115200', 'flash-id'];
}

/** ESP32-S3 ROM programmer; no other Espressif platforms are registered here. */
export function buildFlashArgs(
  port: string,
  baudRate: number,
  segments: FlashSegment[],
  chip = 'esp32s3',
  flashSize?: number,
): string[] {
  validateTarget(port, chip);
  if (!Number.isInteger(baudRate) || baudRate < 9600 || baudRate > 3000000)
    throw new Error('errors.unsupportedBaudRate');
  if (!segments.length) throw new Error('errors.noFirmware');
  const sorted = [...segments].sort((a, b) => a.offset - b.offset);
  for (let index = 0; index < sorted.length; index++) {
    const segment = sorted[index]!;
    if (!Number.isSafeInteger(segment.offset) || segment.offset < 0 || segment.offset % 0x1000 !== 0)
      throw new Error('errors.invalidFlashOffset');
    if (!segment.path || segment.path.startsWith('-') || /[\r\n\0]/.test(segment.path))
      throw new Error('errors.invalidFirmwarePath');
    if (segment.size !== undefined && (!Number.isSafeInteger(segment.size) || segment.size <= 0))
      throw new Error('errors.invalidFirmwareSize');
    if (index > 0) {
      const previous = sorted[index - 1]!;
      // Erase works by sector: adjacent unaligned images can otherwise erase each other's contents.
      const previousEnd = previous.offset + Math.ceil((previous.size ?? 1) / 0x1000) * 0x1000;
      if (segment.offset < previousEnd) throw new Error('errors.overlappingFirmware');
    }
    if (flashSize !== undefined && segment.offset + (segment.size ?? 1) > flashSize)
      throw new Error('errors.firmwareOutOfBounds');
  }
  const args = ['-m', 'esptool', '--chip', chip, '--port', port, '--baud', String(baudRate), 'write-flash'];
  if (flashSize !== undefined) {
    const megabytes = flashSize / 1024 / 1024;
    if (![1, 2, 4, 8, 16, 32, 64, 128].includes(megabytes)) throw new Error('errors.unsupportedFlashSize');
    args.push('--flash-size', `${megabytes}MB`);
  }
  for (const segment of sorted) args.push(`0x${segment.offset.toString(16)}`, segment.path);
  return args;
}

export const createProbeArgs = buildProbeArgs;
export const createFlashArgs = buildFlashArgs;
