import type { BoardDefinition } from '../../shared/contracts';

/**
 * A layout page is available when the platform either owns a partition table
 * or exposes a fixed Flash map in read-only form. `partitions` implies the
 * layout view for older registrations that predate the `layout` capability.
 */
export function supportsLayout(board: Pick<BoardDefinition, 'capabilities'> | null | undefined): boolean {
  return !!board && (board.capabilities.includes('layout') || board.capabilities.includes('partitions'));
}

/** Only platforms that own a partition table may mutate the map. */
export function supportsPartitionEditing(
  board: Pick<BoardDefinition, 'capabilities'> | null | undefined,
): boolean {
  return !!board?.capabilities.includes('partitions');
}
