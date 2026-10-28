import type { BoardAdapter } from '../../types.js';
import type { ProjectConfig } from '../../../src/shared/contracts.js';

const MiB = 1024 * 1024;
const UPLOAD_BAUD_RATES = [115200, 230400, 460800, 921600];

function isCustomFlashSize(size: number): boolean {
  return Number.isInteger(size / MiB) && size >= MiB && size <= 128 * MiB;
}
function createConfig(): ProjectConfig {
  return {
    version: 1,
    name: 'firmware',
    boardId: 'generic',
    port: '',
    baudRate: 115200,
    flashSize: 4 * MiB,
    // A merged image begins at zero. For app-only images users must set the correct app offset.
    partitions: [{ id: 'firmware', name: 'firmware', type: 'app', offset: 0, size: 4 * MiB }],
    toolchain: { mode: 'custom', arduinoCli: '', python: 'python', additionalUrls: [], fqbn: '' },
  };
}

export const genericAdapter: BoardAdapter = {
  definition: {
    id: 'generic',
    name: '通用烧录器',
    family: 'Generic',
    descriptionKey: 'boards.genericDescription',
    flashSizes: [1, 2, 4, 8, 16].map((size) => size * MiB),
    customFlashSize: true,
    baudRates: UPLOAD_BAUD_RATES,
    recommendedBaudRate: 115200,
    probePatterns: [],
    ramSize: 0,
    defaultConfig: createConfig(),
    capabilities: ['flash', 'probe', 'serial', 'partitions'],
  },
  createConfig,
  getFqbn(config) {
    return config.toolchain.fqbn;
  },
  validateConfig(config) {
    if (config.boardId !== 'generic') throw new Error('errors.boardMismatch');
    if (!this.definition.flashSizes.includes(config.flashSize) && !isCustomFlashSize(config.flashSize))
      throw new Error('errors.unsupportedFlashSize');
    if (!UPLOAD_BAUD_RATES.includes(config.baudRate))
      throw new Error('errors.unsupportedBaudRate');
  },
};
