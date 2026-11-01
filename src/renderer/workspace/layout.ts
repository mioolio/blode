import type { ProjectConfig } from '../../shared/contracts';

/**
 * Fixed-layout platforms have one application prefix. Changing physical Flash
 * keeps a deliberately reserved tail, while a full-span application follows
 * the new capacity. Partition-editing platforms keep using PartitionLayout.
 */
export function resizeFixedLayout(
  config: ProjectConfig,
  flashSize: number,
  manualOverride = true,
): ProjectConfig {
  const next: ProjectConfig = {
    ...config,
    flashSize,
    partitions: config.partitions
      .filter((partition) => partition.offset < flashSize)
      .map((partition) => {
        const size =
          partition.offset + partition.size === config.flashSize
            ? flashSize - partition.offset
            : Math.min(partition.size, flashSize - partition.offset);
        return { ...partition, size };
      }),
  };
  if (manualOverride) next.flashSizeOverride = true;
  else delete next.flashSizeOverride;
  return next;
}

/** Allocate a smaller application prefix without changing physical capacity. */
export function resizeAppRegion(config: ProjectConfig, appSize: number): ProjectConfig {
  return {
    ...config,
    partitions: config.partitions.map((partition) =>
      partition.type === 'app' ? { ...partition, size: appSize } : partition,
    ),
  };
}
