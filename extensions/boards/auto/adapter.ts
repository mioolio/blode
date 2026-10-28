import type { BoardAdapter } from '../../types.js';
import type { ProjectConfig } from '../../../src/shared/contracts.js';

const UPLOAD_BAUD_RATES = [115200, 230400, 460800, 921600];

/** Detection-only board: it never compiles or flashes until a real adapter is selected. */
function createConfig(): ProjectConfig {
  return {
    version: 1,
    name: 'project',
    boardId: 'auto',
    port: '',
    baudRate: 460800,
    // Unknown until a registered platform identifies the physical target.
    flashSize: 0,
    partitions: [],
    programmer: { transport: 'auto', serialNumber: '', frequencyKhz: 1800 },
    toolchain: { mode: 'managed', arduinoCli: '', python: '', additionalUrls: [], fqbn: '' },
  };
}

export const autoAdapter: BoardAdapter = {
  definition: {
    id: 'auto',
    name: '自动检测',
    family: 'Auto',
    descriptionKey: 'boards.autoDescription',
    flashSizes: [],
    customFlashSize: false,
    baudRates: UPLOAD_BAUD_RATES,
    recommendedBaudRate: 460800,
    probePatterns: [],
    ramSize: 0,
    defaultConfig: createConfig(),
    capabilities: ['probe', 'serial'],
  },
  createConfig,
  getFqbn(config) {
    return config.toolchain.fqbn;
  },
  validateConfig(config) {
    if (config.boardId !== 'auto') throw new Error('errors.boardMismatch');
    if (config.flashSize !== 0 || config.partitions.length) throw new Error('error.invalidConfig');
    if (!UPLOAD_BAUD_RATES.includes(config.baudRate)) throw new Error('errors.unsupportedBaudRate');
  },
};
