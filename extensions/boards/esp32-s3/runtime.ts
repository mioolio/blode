import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BuildResult, ProjectConfig } from '../../../src/shared/contracts.js';
import type { PlatformRuntime, RuntimeHost } from '../../runtime.js';
import { esp32S3Adapter } from './adapter.js';
import { Toolchains } from './toolchain.js';
import { buildFlashArgs, buildProbeArgs } from './programmer.js';
import { toPartitionCsv } from './layout.js';

function detectedFlashSize(output: string): number | null {
  const match = output.match(/(?:Detected flash size|Flash size)\s*:\s*([\d.]+)\s*MB/i);
  const size = match ? Number(match[1]) * 1024 * 1024 : NaN;
  return Number.isFinite(size) && size >= 1_048_576 ? Math.round(size) : null;
}

/** The complete Arduino/esptool lifecycle lives with the ESP32-S3 package. */
export function createEsp32S3Runtime(host: RuntimeHost): PlatformRuntime {
  const toolchains = new Toolchains(
    host.runCommand,
    host.dataRoot,
    (line) => host.emit(line),
    {
      fetcher: host.fetcher,
      env: host.env,
      signal: host.signal,
      onProgress: (progress) => host.installationProgress?.(progress),
    },
    host.toolchainRoot,
  );
  const readProbe = async (config: ProjectConfig, port: string) => {
    await host.closeSerial();
    const result = await toolchains.runEsptool(config, buildProbeArgs(port), {
      timeout: 45_000,
      onLine: (line) => host.emit(line),
    });
    if (result.code !== 0) throw new Error(result.output || 'error.probeFailed');
    const text = result.stdout ?? result.output;
    if (!/\bESP32-S3\b/i.test(text)) throw new Error('error.boardNotDetected');
    const flashSize = detectedFlashSize(text);
    if (!flashSize) throw new Error('error.probeFailed');
    return { output: result.output, flashSize };
  };
  return {
    id: esp32S3Adapter.definition.id,
    transport: 'serial',
    sourceInputs: [],
    status: (config, refresh) => toolchains.status(config, refresh),
    async install(config) {
      const defaults = esp32S3Adapter.createConfig();
      const target =
        config.boardId === esp32S3Adapter.definition.id
          ? config
          : {
              ...defaults,
              toolchain: {
                ...defaults.toolchain,
                ...(config.toolchain.arduinoCli
                  ? { mode: 'custom' as const, arduinoCli: config.toolchain.arduinoCli }
                  : {}),
                python: config.toolchain.python,
                additionalUrls: [
                  ...new Set([...defaults.toolchain.additionalUrls, ...config.toolchain.additionalUrls]),
                ],
              },
            };
      return toolchains.install(target);
    },
    async discover() {
      return (await host.listPorts())
        .filter((port) => port.vendorId && port.productId)
        .map((port) => ({
          id: `serial:${port.path}`,
          platformId: esp32S3Adapter.definition.id,
          transport: 'serial' as const,
          name: `${port.path}${port.manufacturer ? ` · ${port.manufacturer}` : ''}`,
          port: port.path,
        }));
    },
    async probe(config, selection) {
      const port = await host.requirePort(selection?.port || config.port);
      const result = await readProbe(config, port);
      const ownPlatform = config.boardId === esp32S3Adapter.definition.id;
      const base = esp32S3Adapter.createConfigForFlash!(result.flashSize);
      if (base.flashSize !== result.flashSize) throw new Error('errors.unsupportedFlashSize');
      const next: ProjectConfig = {
        ...base,
        name: config.name,
        port,
        baudRate: ownPlatform ? config.baudRate : base.baudRate,
        ...(ownPlatform && config.flashSize === base.flashSize ? { partitions: config.partitions } : {}),
        toolchain: ownPlatform
          ? { ...config.toolchain }
          : {
              ...base.toolchain,
              ...(config.toolchain.arduinoCli
                ? { mode: 'custom', arduinoCli: config.toolchain.arduinoCli }
                : {}),
              python: config.toolchain.python,
              additionalUrls: [
                ...new Set([...base.toolchain.additionalUrls, ...config.toolchain.additionalUrls]),
              ],
            },
      };
      esp32S3Adapter.validateConfig(next);
      toolchains.invalidate();
      return { output: result.output, config: next };
    },
    async build(config, buildInputs) {
      esp32S3Adapter.validateConfig(config);
      const status = await toolchains.status(config, true);
      if (!status.arduinoCli || !status.esp32Core) throw new Error('error.toolchainMissing');
      const allFiles = await host.readProjectFiles();
      let files = allFiles;
      let entryFile: string | undefined;
      let entryDirectory = '';
      if (buildInputs.entry) {
        const entry = buildInputs.entry.replaceAll('\\', '/');
        const fullPath = entry === '.' ? host.projectRoot() : await host.resolveWorkspacePath(entry);
        const stat = await fs.stat(fullPath);
        entryDirectory = stat.isDirectory() ? (entry === '.' ? '' : entry) : path.posix.dirname(entry);
        if (entryDirectory === '.') entryDirectory = '';
        if (stat.isFile()) entryFile = entry;
        if (!stat.isDirectory() && !stat.isFile()) throw new Error('error.invalidPath');
        files = files.filter((file) => !entryDirectory || file.path.startsWith(`${entryDirectory}/`));
      }
      if (buildInputs.files?.length) {
        const byPath = new Map(allFiles.map((file) => [file.path, file]));
        const declaredFiles = [...new Set([...buildInputs.files, ...(entryFile ? [entryFile] : [])])];
        files = declaredFiles.map((declared) => {
          const file = byPath.get(declared.replaceAll('\\', '/'));
          if (!file) throw new Error('error.projectFileMissing');
          if (entryDirectory && !file.path.startsWith(`${entryDirectory}/`))
            throw new Error('error.buildFileOutsideEntry');
          return file;
        });
      }
      const declaredSketch =
        entryFile ?? (!buildInputs.entry ? buildInputs.sketch?.replaceAll('\\', '/') : undefined);
      let main = declaredSketch ? files.find((file) => file.path === declaredSketch) : undefined;
      if (declaredSketch && !main) throw new Error('error.projectFileMissing');
      if (main && !main.path.endsWith('.ino')) throw new Error('error.noSketch');
      main ??=
        files.find(
          (file) => file.path.endsWith('.ino') && path.posix.dirname(file.path) === (entryDirectory || '.'),
        ) ?? files.find((file) => file.path.endsWith('.ino'));
      if (!main) throw new Error('error.noSketch');
      const sketchName = path.basename(host.projectRoot()).replace(/[^a-zA-Z0-9_]/g, '_') || 'sketch';
      const stage = await host.resetDirectory(`.blode/staging/${sketchName}`);
      for (const file of files) {
        const destination = path.join(
          stage,
          file === main
            ? `${sketchName}.ino`
            : entryDirectory
              ? path.posix.relative(entryDirectory, file.path)
              : file.path,
        );
        const relative = path.relative(stage, destination);
        if (
          !relative ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          throw new Error('error.invalidPath');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.content, 'utf8');
      }
      await fs.writeFile(path.join(stage, 'partitions.csv'), toPartitionCsv(config.partitions));
      const outputDirectory = await host.resetDirectory('.blode/build');
      const result = await toolchains.runCli(
        config,
        [
          'compile',
          '--fqbn',
          esp32S3Adapter.getFqbn(config),
          '--build-path',
          outputDirectory,
          '--warnings',
          'all',
          '--build-property',
          `upload.maximum_size=${config.partitions.find((partition) => partition.type === 'app')!.size}`,
          stage,
        ],
        900_000,
      );
      const expectedBinaries = [
        `${sketchName}.ino.bin`,
        `${sketchName}.ino.bootloader.bin`,
        `${sketchName}.ino.partitions.bin`,
      ];
      const binaries = (await fs.readdir(outputDirectory)).filter((file) => expectedBinaries.includes(file));
      const sketchBinary = binaries.find((file) => file === `${sketchName}.ino.bin`);
      const binarySize = sketchBinary ? (await fs.stat(path.join(outputDirectory, sketchBinary))).size : 0;
      return parseBuildOutput(result.output, {
        success: result.code === 0 && expectedBinaries.every((file) => binaries.includes(file)),
        flashTotal: config.partitions.find((partition) => partition.type === 'app')!.size,
        ramTotal: esp32S3Adapter.definition.ramSize,
        binarySize,
        artifacts: binaries.map((file) => `.blode/build/${file}`),
      });
    },
    async flash(config, buildResult) {
      esp32S3Adapter.validateConfig(config);
      const port = await host.requirePort(config.port);
      const target = await readProbe(config, port);
      if (target.flashSize && config.flashSize > target.flashSize)
        throw new Error('error.deviceFlashTooSmall');
      const bootloader = buildResult.artifacts.find((file) => file.endsWith('.bootloader.bin'));
      const table = buildResult.artifacts.find((file) => file.endsWith('.partitions.bin'));
      const application = buildResult.artifacts.find((file) => file.endsWith('.ino.bin'));
      if (!bootloader || !table || !application) throw new Error('error.noFirmware');
      const segments = await Promise.all(
        [
          { file: bootloader, offset: 0 },
          { file: table, offset: 0x8000 },
          {
            file: application,
            offset: config.partitions.find((partition) => partition.type === 'app')!.offset,
          },
        ].map(async (segment) => {
          const fullPath = await host.resolveWorkspacePath(segment.file, { internal: true });
          return { path: fullPath, offset: segment.offset, size: (await fs.stat(fullPath)).size };
        }),
      );
      const result = await toolchains.runEsptool(
        config,
        buildFlashArgs(port, config.baudRate, segments, 'esp32s3', config.flashSize),
        { timeout: 180_000, onLine: (line) => host.emit(line) },
      );
      if (result.code !== 0) throw new Error(result.output || 'error.flashFailed');
    },
    async flashPrepared(config, image) {
      esp32S3Adapter.validateConfig(config);
      const stat = await fs.lstat(image.path);
      const bytes = await fs.readFile(image.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        bytes.length !== image.size ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256
      )
        throw new Error('firmware.fileChanged');
      if (!Number.isSafeInteger(image.address) || image.address < 0 || image.address % 0x1000 || !image.size)
        throw new Error('errors.invalidFlashOffset');
      const port = await host.requirePort(config.port);
      const target = await readProbe(config, port);
      if (image.address + image.size > target.flashSize) throw new Error('errors.firmwareOutOfBounds');
      const result = await toolchains.runEsptool(
        config,
        buildFlashArgs(
          port,
          config.baudRate,
          [{ path: image.path, offset: image.address, size: image.size }],
          'esp32s3',
          target.flashSize,
        ),
        { timeout: 180_000, onLine: (line) => host.emit(line) },
      );
      if (result.code !== 0) throw new Error(result.output || 'error.flashFailed');
    },
    invalidate: () => toolchains.invalidate(),
  };
}

export function parseBuildOutput(
  output: string,
  defaults: {
    success: boolean;
    flashTotal: number;
    ramTotal: number;
    binarySize: number;
    artifacts: string[];
  },
): BuildResult {
  const flash = output.match(/Sketch uses\s+([\d,]+)\s+bytes/i);
  const ram = output.match(/Global variables use\s+([\d,]+)\s+bytes/i);
  const maximum = output.match(/Global variables use[^\r\n]*Maximum is\s+([\d,]+)\s+bytes/i);
  const number = (value: string | undefined) => Number(value?.replaceAll(',', '') ?? 0);
  return {
    success: defaults.success,
    flashUsed: flash ? number(flash[1]) : defaults.binarySize,
    ramUsed: number(ram?.[1]),
    flashTotal: defaults.flashTotal,
    ramTotal: maximum ? number(maximum[1]) : defaults.ramTotal,
    artifacts: defaults.artifacts,
    timestamp: new Date().toISOString(),
    output,
  };
}
