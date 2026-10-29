import type { BoardDefinition, ProjectConfig } from '../src/shared/contracts.js';

/** A board owns device facts and configuration; hardware I/O stays in core services. */
export interface BoardAdapter {
  readonly languageAssets?: Record<string, unknown>;
  readonly definition: BoardDefinition;
  createConfig(): ProjectConfig;
  /** Match a physically detected Flash capacity with a valid layout; optional for fixed-layout boards. */
  createConfigForFlash?(flashSize: number): ProjectConfig;
  getFqbn(config: ProjectConfig): string;
  validateConfig(config: ProjectConfig): void;
}

/** Offsets are bytes, not sectors. Paths are resolved and authorized by the caller. */
export interface FlashSegment {
  offset: number;
  path: string;
  size?: number;
}
