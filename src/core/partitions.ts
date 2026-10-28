import type { Partition } from '../shared/contracts';

/** ESP flash maps are byte based. Keep this validation shared by save and build. */
export function validatePartitions(
  partitions: Partition[],
  flashSize: number,
  options: { reserveEspSystem?: boolean } = {},
): void {
  if (!Number.isSafeInteger(flashSize) || flashSize < 1_048_576 || flashSize > 128 * 1_048_576)
    throw new Error('error.flashSize');
  if (!partitions.length || partitions.length > 32) throw new Error('error.partitionCount');
  const ids = new Set<string>();
  const sorted = [...partitions].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (!/^[a-zA-Z0-9_-]{1,16}$/.test(p.id) || !/^[a-zA-Z0-9_-]{1,16}$/.test(p.name) || ids.has(p.id))
      throw new Error('error.partitionName');
    ids.add(p.id);
    if (
      !Number.isSafeInteger(p.offset) ||
      !Number.isSafeInteger(p.size) ||
      p.offset < 0 ||
      p.size <= 0 ||
      p.offset + p.size > flashSize
    )
      throw new Error('error.partitionBounds');
    if (p.offset % 0x1000 !== 0 || p.size % 0x1000 !== 0) throw new Error('error.partitionAlignment');
    if (
      options.reserveEspSystem !== false &&
      p.type === 'app' &&
      (p.offset % 0x10000 !== 0 || p.offset < 0x10000)
    )
      throw new Error('error.appAlignment');
    if (options.reserveEspSystem !== false && p.type !== 'system' && p.offset < 0x9000)
      throw new Error('error.reservedFlash');
    if (i > 0 && sorted[i - 1].offset + sorted[i - 1].size > p.offset)
      throw new Error('error.partitionOverlap');
  }
  if (!partitions.some((p) => p.type === 'app')) throw new Error('error.noAppPartition');
}

/** System blocks live outside the partition table; their placement is board-owned. */
export function toPartitionCsv(partitions: Partition[]): string {
  let appCount = 0;
  const dataSubtypes: Record<string, string> = { nvs: 'nvs', otadata: 'ota', phy_init: 'phy', coredump: 'coredump' };
  const rows = [...partitions]
    .sort((a, b) => a.offset - b.offset)
    .filter((p) => p.type !== 'system')
    .map((p) => {
      const subtype = p.type === 'app'
        ? (appCount++ === 0 ? 'factory' : `ota_${appCount - 2}`)
        : dataSubtypes[p.name] ?? 'spiffs';
      return `${p.name},${p.type},${subtype},0x${p.offset.toString(16)},0x${p.size.toString(16)},`;
    });
  return '# Name,Type,SubType,Offset,Size,Flags\n' + rows.join('\n') + '\n';
}
