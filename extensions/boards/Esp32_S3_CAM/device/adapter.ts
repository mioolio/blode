import type { BoardAdapter } from '../../../types.js';
import type { ProjectConfig } from '../../../../src/shared/contracts.js';
import { createDefaultPartitions } from '../layout/partitions.js';
import { validatePartitions } from '../layout/index.js';
import declaration from '../manifest.json';
import type { RuntimePluginManifest } from '../../../../src/shared/plugins.js';
import { languageAssets } from '../languages/index.js';

export const ESP32_PACKAGE_URL = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json';
const MiB = 1024 * 1024;
const UPLOAD_BAUD_RATES = [115200, 230400, 460800, 921600];
const MAX_FLASH_SIZE = 128 * MiB;

/** Custom capacities stay MiB-aligned so the partition table remains predictable. */
function isCustomFlashSize(size: number): boolean {
  return Number.isInteger(size / MiB) && size >= MiB && size <= MAX_FLASH_SIZE;
}

function createConfig(): ProjectConfig {
  return {
    version: 1,
    name: 'blink',
    boardId: 'Esp32_S3_CAM',
    port: '',
    baudRate: 460800,
    flashSize: 8 * MiB,
    partitions: createDefaultPartitions(),
    toolchain: {
      mode: 'managed',
      arduinoCli: '',
      python: '',
      additionalUrls: [ESP32_PACKAGE_URL],
      fqbn: 'esp32:esp32:esp32s3',
    },
  };
}

/** A detected capacity regenerates the layout instead of stretching the default one. */
function createConfigForFlash(flashSize: number): ProjectConfig {
  const config = createConfig();
  if (!Number.isInteger(flashSize / MiB) || flashSize < 4 * MiB || flashSize > MAX_FLASH_SIZE) return config;
  config.flashSize = flashSize;
  config.partitions = createDefaultPartitions(flashSize);
  return config;
}

/** Preserve compiler options while keeping FlashSize in sync with the layout. */
function getFqbn(config: ProjectConfig): string {
  const base = config.toolchain.fqbn || 'esp32:esp32:esp32s3';
  if (!/^esp32:esp32:esp32s3(?::|$)/.test(base)) throw new Error('errors.boardFqbnMismatch');
  const options = new Map<string, string>([['PSRAM', 'disabled']]);
  const suffix = base.split(':').slice(3).join(':');
  for (const item of suffix.split(',').filter(Boolean)) {
    const pair = item.split('=');
    if (pair.length !== 2 || !/^[\w-]+$/.test(pair[0]!) || !/^[\w.-]+$/.test(pair[1]!)) {
      throw new Error('errors.invalidFqbn');
    }
    options.set(pair[0]!, pair[1]!);
  }
  // Flash capacity is a single source of truth; stale FQBN options cannot silently override it.
  options.set('FlashSize', `${config.flashSize / MiB}M`);
  // UploadSpeed menu values differ across core releases and host platforms.
  // Our programmer owns the runtime baud rate; it is not a compiler option.
  options.delete('UploadSpeed');
  return `esp32:esp32:esp32s3:${[...options].map(([key, value]) => `${key}=${value}`).join(',')}`;
}

export const esp32S3Adapter: BoardAdapter = {
  languageAssets,
  definition: {
    runtimePlugin: declaration as unknown as RuntimePluginManifest,
    id: 'Esp32_S3_CAM',
    name: 'Esp32_S3_CAM',
    family: 'Espressif',
    descriptionKey: 'boards.esp32s3Description',
    flashSizes: [4, 8, 16].map((size) => size * MiB),
    customFlashSize: true,
    baudRates: UPLOAD_BAUD_RATES,
    recommendedBaudRate: 460800,
    probePatterns: ['ESP32-S3'],
    ramSize: 327680,
    defaultConfig: createConfig(),
    capabilities: ['compile', 'flash', 'probe', 'serial', 'layout', 'partitions', 'debug'],
  },
  createConfig,
  createConfigForFlash,
  getFqbn,
  validateConfig(config) {
    if (config.boardId !== 'Esp32_S3_CAM') throw new Error('errors.boardMismatch');
    if (!config.toolchain.fqbn) throw new Error('error.invalidConfig');
    if (config.programmer && config.programmer.transport !== 'serial')
      throw new Error('error.debugTransportMismatch');
    if (!this.definition.flashSizes.includes(config.flashSize) && !isCustomFlashSize(config.flashSize))
      throw new Error('errors.unsupportedFlashSize');
    if (!UPLOAD_BAUD_RATES.includes(config.baudRate)) throw new Error('errors.unsupportedBaudRate');
    // The ROM and compiled bootloader require these exact system addresses.
    // They are visible in the map, but cannot be relocated by a generic layout editor.
    const systems = config.partitions.filter((partition) => partition.type === 'system');
    const bootloader = systems.find((partition) => partition.id === 'bootloader');
    const table = systems.find((partition) => partition.id === 'partition-table');
    if (
      systems.length !== 2 ||
      !bootloader ||
      !table ||
      bootloader.offset !== 0 ||
      bootloader.size !== 0x8000 ||
      table.offset !== 0x8000 ||
      table.size !== 0x1000
    ) {
      throw new Error('errors.systemPartitionLocked');
    }
    // OTA needs explicit subtype/boot-selection metadata; do not silently manufacture it.
    if (config.partitions.filter((partition) => partition.type === 'app').length !== 1)
      throw new Error('errors.singleAppRequired');
    getFqbn(config);
    validatePartitions(config.partitions, config.flashSize);
  },
};
