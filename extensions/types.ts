import type { BoardDefinition, ProjectConfig } from '../src/shared/contracts.js';

/** A board owns device facts and configuration; hardware I/O stays in core services. */
export interface BoardAdapter {
  readonly definition: BoardDefinition;
  createConfig(): ProjectConfig;
  getFqbn(config: ProjectConfig): string;
  validateConfig(config: ProjectConfig): void;
}

/** Offsets are bytes, not sectors. Paths are resolved and authorized by the caller. */
export interface FlashSegment {
  offset: number;
  path: string;
  size?: number;
}
