import type { Partition } from '../../../src/shared/contracts.js';

/** ESP32-S3 geometry, reservations and partition CSV belong to this platform. */
export function validatePartitions(partitions: Partition[], flashSize: number): void {
  if (!Number.isSafeInteger(flashSize) || flashSize < 1_048_576 || flashSize > 128 * 1_048_576)
    throw new Error('error.flashSize');
  if (!partitions.length || partitions.length > 32) throw new Error('error.partitionCount');
  const ids = new Set<string>();
  const sorted = [...partitions].sort((a, b) => a.offset - b.offset);
  for (let index = 0; index < sorted.length; index++) {
    const partition = sorted[index];
    if (
      !/^[a-zA-Z0-9_-]{1,16}$/.test(partition.id) ||
      !/^[a-zA-Z0-9_-]{1,16}$/.test(partition.name) ||
      ids.has(partition.id)
    )
      throw new Error('error.partitionName');
    ids.add(partition.id);
    if (
      !Number.isSafeInteger(partition.offset) ||
      !Number.isSafeInteger(partition.size) ||
      partition.offset < 0 ||
      partition.size <= 0 ||
      partition.offset + partition.size > flashSize
    )
      throw new Error('error.partitionBounds');
    if (partition.offset % 0x1000 !== 0 || partition.size % 0x1000 !== 0)
      throw new Error('error.partitionAlignment');
    if (partition.type === 'app' && (partition.offset % 0x10000 !== 0 || partition.offset < 0x10000))
      throw new Error('error.appAlignment');
    if (partition.type !== 'system' && partition.offset < 0x9000) throw new Error('error.reservedFlash');
    if (index > 0 && sorted[index - 1].offset + sorted[index - 1].size > partition.offset)
      throw new Error('error.partitionOverlap');
  }
  if (!partitions.some((partition) => partition.type === 'app')) throw new Error('error.noAppPartition');
}

/** Bootloader and partition-table system blocks are outside the CSV itself. */
export function toPartitionCsv(partitions: Partition[]): string {
  let appCount = 0;
  const dataSubtypes: Record<string, string> = {
    nvs: 'nvs',
    otadata: 'ota',
    phy_init: 'phy',
    coredump: 'coredump',
  };
  const rows = [...partitions]
    .sort((a, b) => a.offset - b.offset)
    .filter((partition) => partition.type !== 'system')
    .map((partition) => {
      const subtype =
        partition.type === 'app'
          ? appCount++ === 0
            ? 'factory'
            : `ota_${appCount - 2}`
          : (dataSubtypes[partition.name] ?? 'spiffs');
      return `${partition.name},${partition.type},${subtype},0x${partition.offset.toString(16)},0x${partition.size.toString(16)},`;
    });
  return '# Name,Type,SubType,Offset,Size,Flags\n' + rows.join('\n') + '\n';
}
