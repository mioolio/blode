import type { BoardAdapter } from './types.js';
import type { ProjectConfig } from '../src/shared/contracts.js';
import type { RuntimePluginManifest } from '../src/shared/plugins.js';

export function customNumber(config: ProjectConfig, key: string, fallback: number): number {
  const value = config.runtime?.values?.[key];
  return value === undefined || value === '' ? fallback : Number(value);
}

export function customBootAddress(config: ProjectConfig): number {
  const selected = config.runtime?.values?.bootloaderAddress;
  if (selected !== undefined && selected !== '' && selected !== 'auto') return Number(selected);
  const fqbn = String(config.runtime?.values?.fqbn || config.toolchain.fqbn);
  return config.runtime?.values?.chip === 'esp32' || fqbn.split(':')[2] === 'esp32' ? 0x1000 : 0;
}

/** Custom modules validate address ranges, without a model allowlist. */
export function createCustomAdapter(manifest: RuntimePluginManifest): BoardAdapter {
  const createConfig = () => structuredClone(manifest.defaultConfig);
  return {
    definition: {
      id: manifest.id,
      name: manifest.name,
      family: manifest.vendor ?? manifest.name,
      descriptionKey: manifest.descriptionKey ?? '',
      runtimePlugin: manifest,
      flashSizes: manifest.layout.recommendedFlashSizes,
      customFlashSize: true,
      baudRates: [9600, 57600, 115200, 230400, 460800, 921600, 1500000, 2000000],
      recommendedBaudRate: manifest.defaultConfig.baudRate,
      probePatterns: [],
      ramSize: manifest.layout.ramSize,
      layout: { baseAddress: manifest.layout.flashBaseAddress ?? 0 },
      defaultConfig: createConfig(),
      capabilities: manifest.capabilities,
      ...(manifest.transport === 'stlink' ? { requiredDrivers: ['stlink'] } : {}),
    },
    createConfig,
    createConfigForFlash(size) {
      const config = createConfig();
      config.flashSize = size;
      config.partitions = [{ id: 'firmware', name: 'firmware', type: 'app', offset: 0, size }];
      return config;
    },
    getFqbn(config) {
      return String(config.runtime?.values?.fqbn || config.toolchain.fqbn);
    },
    validateConfig(config) {
      if (config.boardId !== manifest.id) throw new Error('errors.boardMismatch');
      if (!Number.isSafeInteger(config.flashSize) || config.flashSize < 4 || config.flashSize > 0xffffffff)
        throw new Error('errors.unsupportedFlashSize');
      if (!Number.isInteger(config.baudRate) || config.baudRate < 1200 || config.baudRate > 3000000)
        throw new Error('errors.unsupportedBaudRate');
      const base = customNumber(config, 'flashAddress', manifest.layout.flashBaseAddress ?? 0);
      if (!Number.isSafeInteger(base) || base < 0 || base + config.flashSize > 0x100000000)
        throw new Error('errors.invalidFlashOffset');
      const ids = new Set<string>(),
        names = new Set<string>();
      let end = 0;
      for (const region of [...config.partitions].sort((a, b) => a.offset - b.offset)) {
        if (
          !region.name.trim() ||
          ids.has(region.id) ||
          names.has(region.name) ||
          !Number.isSafeInteger(region.offset) ||
          !Number.isSafeInteger(region.size) ||
          region.offset < end ||
          region.size <= 0 ||
          region.offset + region.size > config.flashSize
        )
          throw new Error('errors.invalidPartition');
        ids.add(region.id);
        names.add(region.name);
        end = region.offset + region.size;
      }
      if (config.partitions.filter((item) => item.type === 'app').length !== 1)
        throw new Error('errors.singleAppRequired');
      if (manifest.transport === 'stlink' && config.programmer?.transport !== 'stlink')
        throw new Error('errors.invalidProgrammer');
    },
  };
}
