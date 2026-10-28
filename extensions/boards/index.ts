import { getBoardAdapter, listBoards } from '../registry.js';

/** Definitions are data-only; executable adaptation stays behind BoardAdapter. */
export const boards = listBoards();
export function getBoard(id: string) {
  return structuredClone(getBoardAdapter(id).definition);
}
