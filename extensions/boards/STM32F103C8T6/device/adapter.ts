import type { BoardAdapter } from '../../../types.js';
import type { ProjectConfig } from '../../../../src/shared/contracts.js';
import declaration from '../manifest.json';
import type { RuntimePluginManifest } from '../../../../src/shared/plugins.js';
import { languageAssets } from '../languages/index.js';
import { isStm32FlashSize, validateSwdFrequency } from './protocol.js';

const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function createConfigForFlash(flashSize: number): ProjectConfig {
  if (!isStm32FlashSize(flashSize)) throw new Error('errors.unsupportedFlashSize');
  return {
    version: 1,
    name: 'firmware',
    boardId: 'STM32F103C8T6',
    port: '',
    baudRate: 115200,
    flashSize,
    partitions: [{ id: 'firmware', name: 'firmware', type: 'app', offset: 0, size: flashSize }],
    programmer: { transport: 'stlink', serialNumber: '', frequencyKhz: 1800 },
    toolchain: {
      mode: 'managed',
      arduinoCli: '',
      python: '',
      additionalUrls: [],
      fqbn: '',
      stlinkDirectory: '',
      armCompilerDirectory: '',
    },
  };
}

function createConfig(): ProjectConfig {
  return createConfigForFlash(64 * 1024);
}

/** STM32F103C8T6 profile; callers can override the Flash allocation explicitly. */
export const stm32Adapter: BoardAdapter = {
  languageAssets,
  definition: {
    runtimePlugin: declaration as unknown as RuntimePluginManifest,
    id: 'STM32F103C8T6',
    name: 'STM32F103C8T6',
    family: 'STMicroelectronics',
    descriptionKey: 'boards.stm32Description',
    flashSizes: [64 * 1024],
    customFlashSize: true,
    baudRates,
    recommendedBaudRate: 115200,
    probePatterns: ['STM32F103', 'STM32F1xx_MD'],
    ramSize: 20 * 1024,
    // The map is fixed at the MCU Flash alias; only a full firmware image is writable.
    layout: { baseAddress: 0x08000000 },
    defaultConfig: createConfig(),
    capabilities: ['compile', 'validate-firmware', 'flash', 'probe', 'serial', 'layout'],
    requiredDrivers: ['stlink'],
  },
  createConfig,
  createConfigForFlash,
  getFqbn() {
    return '';
  },
  validateConfig(config) {
    if (config.boardId !== 'STM32F103C8T6') throw new Error('errors.boardMismatch');
    if (!isStm32FlashSize(config.flashSize)) throw new Error('errors.unsupportedFlashSize');
    if (!baudRates.includes(config.baudRate)) throw new Error('errors.unsupportedBaudRate');
    if (config.programmer && config.programmer.transport !== 'stlink')
      throw new Error('errors.invalidProgrammer');
    validateSwdFrequency(config.programmer?.frequencyKhz ?? 1800);
    // The binary programmer owns one application prefix at the Flash base.
    // Data/system regions are reservations with no write path, so they may sit
    // after the app as long as every range is page-aligned and non-overlapping.
    const apps = config.partitions.filter((partition) => partition.type === 'app');
    const firmware = apps[0];
    if (
      apps.length !== 1 ||
      !firmware ||
      firmware.offset !== 0 ||
      !isStm32FlashSize(firmware.size) ||
      firmware.size % 1024 !== 0 ||
      firmware.size > config.flashSize
    )
      throw new Error('errors.invalidPartition');
    const sorted = [...config.partitions].sort((left, right) => left.offset - right.offset);
    for (let index = 0; index < sorted.length; index++) {
      const partition = sorted[index]!;
      if (
        partition.size <= 0 ||
        partition.offset % 1024 !== 0 ||
        partition.size % 1024 !== 0 ||
        partition.offset + partition.size > config.flashSize
      )
        throw new Error('errors.invalidPartition');
      const previous = sorted[index - 1];
      if (previous && previous.offset + previous.size > partition.offset)
        throw new Error('errors.invalidPartition');
    }
  },
};
