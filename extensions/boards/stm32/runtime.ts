import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectBuildInputs, ProjectConfig, ToolchainStatus } from '../../../src/shared/contracts.js';
import type { PlatformRuntime, RuntimeHost } from '../../runtime.js';
import { stm32Adapter } from './adapter.js';
import { appRegionSize } from './layout.js';
import { StlinkProgrammer } from './programmer.js';
import { isStm32FlashSize, STM32_FLASH_BASE } from './protocol.js';
import { Stm32Compiler } from './compiler.js';

export type Stm32Programmer = Pick<StlinkProgrammer, 'status' | 'listProbes' | 'probe' | 'flash' | 'install'>;

/** USB/SWD and precompiled binary programming are owned by the STM32 package. */
export function createStm32Runtime(host: RuntimeHost, programmerOverride?: Stm32Programmer): PlatformRuntime {
  const compiler = new Stm32Compiler(host);
  const sourceBuild = (build: ProjectBuildInputs): ProjectBuildInputs => ({
    ...build,
    entry: build.entry ?? build.sketch,
  });
  const programmer =
    programmerOverride ??
    new StlinkProgrammer({
      root: path.join(host.toolchainRoot ?? path.join(host.dataRoot, 'toolchains'), 'stlink'),
      fetcher: host.fetcher,
      signal: host.signal,
      onLine: (line) => host.emit(line),
      runner: host.runCommand,
    });
  const status = async (config: ProjectConfig): Promise<ToolchainStatus> => {
    const [current, compilation] = await Promise.all([
      programmer.status(config.toolchain.stlinkDirectory),
      compiler.status(config),
    ]);
    return {
      arduinoCli: false,
      esp32Core: false,
      python: false,
      esptool: false,
      stlink: current.installed,
      armCompiler: compilation.installed,
      versions: {
        stlink: current.version,
        ...(compilation.version ? { armCompiler: compilation.version } : {}),
      },
    };
  };
  return {
    id: stm32Adapter.definition.id,
    transport: 'stlink',
    sourceInputs: [],
    async projectConfig(config, build) {
      const device = await compiler.projectDevice(sourceBuild(build));
      if (!device) return null;
      const base = stm32Adapter.createConfigForFlash!(/(?:CB|RB|TB)$/i.test(device) ? 131072 : 65536);
      return {
        ...base,
        name: config.name,
        toolchain: {
          ...base.toolchain,
          armCompilerDirectory: config.toolchain.armCompilerDirectory,
          stlinkDirectory: config.toolchain.stlinkDirectory,
        },
      };
    },
    buildInputs: (_config, build) => compiler.buildInputs(sourceBuild(build)),
    status,
    async install(config) {
      if (!config.toolchain.stlinkDirectory) await programmer.install();
      const current = await status(config);
      if (!current.stlink) throw new Error('errors.stlinkMissing');
      return current;
    },
    async discover(config) {
      if (!(await status(config)).stlink) throw new Error('errors.stlinkMissing');
      return (
        await programmer.listProbes(config.toolchain.stlinkDirectory, config.programmer?.frequencyKhz ?? 1800)
      ).map((device) => ({
        id: `stlink:${device.serialNumber}`,
        platformId: stm32Adapter.definition.id,
        transport: 'stlink' as const,
        name: `${device.description ? `${device.description} · ` : ''}${device.serialNumber}`,
        serialNumber: device.serialNumber,
        debugProbe: device,
      }));
    },
    async probe(config, selection) {
      const serialNumber = selection?.serialNumber || config.programmer?.serialNumber;
      if (!serialNumber) throw new Error('error.selectDebugProbe');
      const frequencyKhz = config.programmer?.frequencyKhz ?? 1800;
      const target = await programmer.probe(serialNumber, frequencyKhz, config.toolchain.stlinkDirectory);
      if (!target.device.flashSize || !target.device.chipId) throw new Error('errors.stlinkTargetUnknown');
      const ownPlatform = config.boardId === stm32Adapter.definition.id;
      // A probe report can be wrong on clone parts. An explicit user capacity is
      // authoritative and survives re-identification; partitions stay in sync.
      const overrideSize =
        ownPlatform &&
        config.flashSizeOverride &&
        isStm32FlashSize(config.flashSize) &&
        config.flashSize <= target.device.flashSize
          ? config.flashSize
          : undefined;
      const base = stm32Adapter.createConfigForFlash!(overrideSize ?? target.device.flashSize);
      const next: ProjectConfig = {
        ...base,
        name: config.name,
        port: config.port,
        baudRate: ownPlatform ? config.baudRate : base.baudRate,
        ...(ownPlatform && config.flashSize === base.flashSize ? { partitions: config.partitions } : {}),
        ...(overrideSize !== undefined ? { flashSizeOverride: true } : {}),
        toolchain: {
          ...base.toolchain,
          stlinkDirectory: config.toolchain.stlinkDirectory ?? '',
          armCompilerDirectory: config.toolchain.armCompilerDirectory ?? '',
        },
        programmer: {
          transport: 'stlink',
          serialNumber: target.device.serialNumber,
          frequencyKhz,
          targetChipId: target.device.chipId,
        },
      };
      stm32Adapter.validateConfig(next);
      host.emit('status.stm32Detected', 'success');
      return { output: target.output, config: next, debugProbes: [target.device] };
    },
    async build(config, build) {
      stm32Adapter.validateConfig(config);
      const inputs = sourceBuild(build);
      if (inputs.entry) return compiler.build(config, inputs);
      const binary = await host.resolveWorkspacePath('firmware.bin');
      const info = await fs.stat(binary).catch(() => {
        throw new Error('error.noFirmware');
      });
      const appSize = appRegionSize(config);
      // The application region is a soft allocation; physical Flash is the hard bound.
      if (!info.isFile() || info.size <= 0 || info.size > config.flashSize)
        throw new Error('error.firmwareTooLarge');
      host.emit('status.firmwareValidated', 'success');
      return {
        success: true,
        flashUsed: info.size,
        ramUsed: 0,
        flashTotal: appSize,
        ramTotal: stm32Adapter.definition.ramSize,
        artifacts: ['firmware.bin'],
        timestamp: new Date().toISOString(),
        output: 'status.firmwareValidated',
      };
    },
    async flash(config, build) {
      stm32Adapter.validateConfig(config);
      const selected = config.programmer;
      if (!selected?.serialNumber) throw new Error('error.selectDebugProbe');
      if (!selected.targetChipId) throw new Error('error.stm32ProbeRequired');
      const target = await programmer.probe(
        selected.serialNumber,
        selected.frequencyKhz,
        config.toolchain.stlinkDirectory,
      );
      if (target.device.chipId?.toLowerCase() !== selected.targetChipId.toLowerCase())
        throw new Error('error.chipMismatch');
      // A manual override may use less than the reported capacity, but never more.
      // Without an override the probe and configuration must match exactly.
      if (
        !target.device.flashSize ||
        (config.flashSizeOverride
          ? config.flashSize > target.device.flashSize
          : config.flashSize !== target.device.flashSize)
      )
        throw new Error('errors.stlinkCapacityMismatch');
      const binary = build.artifacts.find(
        (file) => file === '.blode/build/firmware.bin' || file === 'firmware.bin',
      );
      if (!binary) throw new Error('error.noFirmware');
      await programmer.flash({
        serialNumber: selected.serialNumber,
        frequencyKhz: selected.frequencyKhz,
        file: await host.resolveWorkspacePath(binary, { internal: binary.startsWith('.blode/') }),
        address: STM32_FLASH_BASE,
        flashSize: config.flashSize,
        directory: config.toolchain.stlinkDirectory,
      });
    },
    invalidate() {},
  };
}
