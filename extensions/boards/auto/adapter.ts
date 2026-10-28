import type { BoardAdapter } from '../../types.js';
import type { ProjectConfig } from '../../../src/shared/contracts.js';

const MiB = 1024 * 1024;
const UPLOAD_BAUD_RATES = [115200, 230400, 460800, 921600];

/** Detection-only board: it never compiles or flashes until a real adapter is selected. */
function createConfig(): ProjectConfig {
  return {
    version: 1,
    name: 'project',
    boardId: 'auto',
    port: '',
    baudRate: 460800,
    flashSize: 4 * MiB,
    // A neutral placeholder layout; a successful probe replaces it with the detected board's layout.
    partitions: [{ id: 'app', name: 'app', type: 'app', offset: 0, size: 4 * MiB }],
    toolchain: { mode: 'custom', arduinoCli: '', python: 'python', additionalUrls: [], fqbn: '' },
  };
}

export const autoAdapter: BoardAdapter = {
  definition: {
    id: 'auto',
    name: '自动检测',
    family: 'Auto',
    descriptionKey: 'boards.autoDescription',
    flashSizes: [1, 2, 4, 8, 16].map((size) => size * MiB),
    customFlashSize: true,
    baudRates: UPLOAD_BAUD_RATES,
    recommendedBaudRate: 460800,
    probePatterns: [],
    ramSize: 0,
    defaultConfig: createConfig(),
    capabilities: ['probe', 'serial', 'partitions'],
  },
  createConfig,
  getFqbn(config) {
    return config.toolchain.fqbn;
  },
  validateConfig(config) {
    if (config.boardId !== 'auto') throw new Error('errors.boardMismatch');
    if (!this.definition.flashSizes.includes(config.flashSize)) {
      const aligned = Number.isInteger(config.flashSize / MiB);
      if (!aligned || config.flashSize < MiB || config.flashSize > 128 * MiB)
        throw new Error('errors.unsupportedFlashSize');
    }
    if (!UPLOAD_BAUD_RATES.includes(config.baudRate))
      throw new Error('errors.unsupportedBaudRate');
    if (!config.partitions.some((partition) => partition.type === 'app'))
      throw new Error('error.noAppPartition');
  },
};
