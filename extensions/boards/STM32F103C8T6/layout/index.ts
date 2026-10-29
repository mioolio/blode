import type { ProjectConfig } from '../../../../src/shared/contracts.js';

/**
 * Main Flash application prefix owned by the single firmware image. The rest of
 * the physical Flash is intentionally left unprogrammed, so compilation, ELF
 * bounds and binary validation use this size instead of the chip capacity.
 */
export function appRegionSize(config: ProjectConfig): number {
  return (
    config.partitions.find((partition) => partition.type === 'app' && partition.offset === 0)?.size ??
    config.flashSize
  );
}
