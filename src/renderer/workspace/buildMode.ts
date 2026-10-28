import type { BoardDefinition, ProjectBuildInputs } from '../../shared/contracts';

/** Platforms can accept existing firmware as well as compiling an explicit source entry. */
export function validatesExistingFirmware(
  board: Pick<BoardDefinition, 'capabilities'> | undefined,
  build: ProjectBuildInputs = {},
): boolean {
  if (!board?.capabilities.includes('flash')) return false;
  if (!board.capabilities.includes('compile')) return true;
  return board.capabilities.includes('validate-firmware') && !(build.entry ?? build.sketch);
}
