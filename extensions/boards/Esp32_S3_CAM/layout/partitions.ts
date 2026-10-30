import type { Partition } from '../../../../src/shared/contracts.js';

const MiB = 1024 * 1024;

/** Single factory app: predictable boot without depending on OTA metadata. */
export function createDefaultPartitions(flashSize = 8 * MiB): Partition[] {
  // Retail boards use 4/8/16 MiB, but custom products may use another MiB-aligned
  // capacity. The layout is only produced for complete, sane images.
  if (!Number.isInteger(flashSize / MiB) || flashSize < 4 * MiB || flashSize > 128 * MiB) {
    throw new Error('errors.unsupportedFlashSize');
  }
  const appSize = 3 * MiB;
  const coredumpOffset = 0x10000 + appSize;
  const coredumpSize = 0x10000;
  const dataOffset = coredumpOffset + coredumpSize;
  return [
    { id: 'bootloader', name: 'bootloader', type: 'system', offset: 0x0, size: 0x8000 },
    { id: 'partition-table', name: 'partition_table', type: 'system', offset: 0x8000, size: 0x1000 },
    { id: 'nvs', name: 'nvs', type: 'data', offset: 0x9000, size: 0x6000 },
    { id: 'phy', name: 'phy_init', type: 'data', offset: 0xf000, size: 0x1000 },
    { id: 'app', name: 'factory', type: 'app', offset: 0x10000, size: appSize },
    { id: 'coredump', name: 'coredump', type: 'data', offset: coredumpOffset, size: coredumpSize },
    { id: 'filesystem', name: 'spiffs', type: 'data', offset: dataOffset, size: flashSize - dataOffset },
  ];
}
