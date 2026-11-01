import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PlatformRuntime, RuntimeHost, RuntimeFirmwareImage } from './runtime.js';
import type { BoardAdapter } from './types.js';
import type { ProjectConfig, ProjectBuildInputs, BuildResult } from '../src/shared/contracts.js';
import { customNumber, customBootAddress } from './custom-adapter.js';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const value = (config: ProjectConfig, key: string, fallback = '') =>
  String(config.runtime?.values?.[key] ?? fallback);

/** A shell is never used. Custom build arguments are a JSON string array. */
export function customBuildArguments(config: ProjectConfig, variables: Record<string, string>): string[] {
  const args: unknown = JSON.parse(value(config, 'buildArguments', '[]') || '[]');
  if (
    !Array.isArray(args) ||
    args.length > 256 ||
    args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))
  )
    throw new Error('custom.invalidBuildArguments');
  return args.map((arg: string) => arg.replace(/\{(root|output|entry)\}/g, (_, key) => variables[key] ?? ''));
}

export function createCustomRuntime(host: RuntimeHost, adapter: BoardAdapter): PlatformRuntime {
  const stm = adapter.definition.runtimePlugin!.transport === 'stlink';
  const root = host.toolchainRoot ?? path.join(host.dataRoot, 'toolchains');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const run = async (command: string, args: string[], timeout = 120000) => {
    const result = await host.runCommand(command, args, {
      cwd: host.projectRoot(),
      signal: host.signal,
      timeout,
      env: host.env,
      onLine: (line) => host.emit(line),
    });
    if (result.code !== 0) throw new Error(result.output || 'error.flashFailed');
    return result.output;
  };
  const stTool = async (config: ProjectConfig, tool: string) => {
    const directory = config.toolchain.stlinkDirectory;
    const candidates = directory
      ? [directory, path.join(directory, 'bin')]
      : [path.join(root, 'stlink', 'bin'), path.join(root, 'stlink')];
    for (const dir of candidates) {
      const file = path.join(dir, tool + suffix);
      if ((await fs.stat(file).catch(() => null))?.isFile()) return file;
    }
    return directory ? path.join(directory, tool + suffix) : tool + suffix;
  };
  const python = async (config: ProjectConfig) => {
    if (config.toolchain.python) return config.toolchain.python;
    for (const directory of [path.join(root, 'python'), path.join(process.cwd(), '.tools/esptool-venv')]) {
      const file = path.join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if ((await fs.stat(file).catch(() => null))?.isFile()) return file;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  };
  const cli = (config: ProjectConfig) =>
    config.toolchain.arduinoCli || path.join(root, 'bin', 'arduino-cli' + suffix);
  const chip = (config: ProjectConfig) => {
    const selected = value(config, 'chip', 'auto').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(selected)) throw new Error('errors.unsupportedChip');
    return selected;
  };
  const serial = (config: ProjectConfig, override?: string) => {
    const selected = override || config.programmer?.serialNumber || '';
    if (!/^[a-f0-9]{8,64}$/i.test(selected)) throw new Error('error.selectDebugProbe');
    return selected;
  };
  const stArgs = (config: ProjectConfig) => [
    '--freq',
    String(config.programmer?.frequencyKhz ?? 1800),
    '--hot-plug',
  ];
  const checkImage = async (image: RuntimeFirmwareImage) => {
    const stat = await fs.lstat(image.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== image.size ||
      digest(await fs.readFile(image.path)) !== image.sha256
    )
      throw new Error('firmware.fileChanged');
  };
  const flashPrepared = async (config: ProjectConfig, image: RuntimeFirmwareImage) => {
    adapter.validateConfig(config);
    await checkImage(image);
    const base = customNumber(config, 'flashAddress', stm ? 0x08000000 : 0);
    if (
      !Number.isSafeInteger(image.address) ||
      image.address < base ||
      !image.size ||
      image.address + image.size > base + config.flashSize ||
      image.address % (stm ? 4 : 4096)
    )
      throw new Error('errors.firmwareOutOfBounds');
    if (stm) {
      await run(
        await stTool(config, 'st-flash'),
        [
          '--serial',
          serial(config),
          ...stArgs(config),
          '--format',
          'binary',
          'write',
          image.path,
          '0x' + image.address.toString(16),
        ],
        180000,
      );
    } else {
      const port = await host.requirePort(config.port);
      await host.closeSerial();
      await run(
        await python(config),
        [
          '-m',
          'esptool',
          '--chip',
          chip(config),
          '--port',
          port,
          '--baud',
          String(config.baudRate),
          'write-flash',
          '0x' + image.address.toString(16),
          image.path,
        ],
        180000,
      );
    }
  };
  return {
    id: adapter.definition.id,
    transport: stm ? 'stlink' : 'serial',
    sourceInputs: [],
    async status(config) {
      const check = async (command: string, args: string[]) => {
        try {
          const result = await host.runCommand(command, args, {
            timeout: 5000,
            signal: host.signal,
            env: host.env,
          });
          return result.code === 0 ? result.output.trim().split(/\r?\n/)[0] : '';
        } catch {
          return '';
        }
      };
      const versions = stm
        ? { stlink: await check(await stTool(config, 'st-flash'), ['--version']) }
        : {
            arduinoCli: await check(cli(config), ['version']),
            esptool: await check(await python(config), ['-m', 'esptool', 'version']),
          };
      return {
        arduinoCli: !!versions.arduinoCli,
        esp32Core: !!versions.arduinoCli,
        python: !!versions.esptool,
        esptool: !!versions.esptool,
        stlink: !!versions.stlink,
        versions: Object.fromEntries(Object.entries(versions).filter(([, v]) => !!v)) as Record<
          string,
          string
        >,
      };
    },
    async install(config) {
      const status = await this.status(config, true);
      if (stm ? !status.stlink : !status.arduinoCli || !status.esptool)
        throw new Error('error.toolchainMissing');
      return status;
    },
    async discover(config) {
      // Explicit custom profiles never compete with identified models in automatic detection.
      if (config.boardId !== adapter.definition.id) return [];
      if (!stm)
        return (await host.listPorts()).map((port) => ({
          id: `serial:${port.path}`,
          platformId: adapter.definition.id,
          transport: 'serial' as const,
          name: port.path,
          port: port.path,
        }));
      const output = await run(await stTool(config, 'st-info'), ['--probe', ...stArgs(config)], 15000);
      return [...output.matchAll(/serial\s*:\s*([a-f0-9]{8,64})/gi)].map((match) => ({
        id: `stlink:${match[1]}`,
        platformId: adapter.definition.id,
        transport: 'stlink' as const,
        name: `ST-Link ${match[1]}`,
        serialNumber: match[1],
        debugProbe: { name: `ST-Link ${match[1]}`, serialNumber: match[1] },
      }));
    },
    async probe(config, selection) {
      if (stm) {
        const selected = serial(config, selection?.serialNumber);
        const output = await run(await stTool(config, 'st-info'), ['--probe', ...stArgs(config)], 15000);
        const blocks = [...output.matchAll(/serial\s*:\s*([a-f0-9]{8,64})([\s\S]*?)(?=serial\s*:|$)/gi)];
        const block = blocks.find((match) => match[1].toLowerCase() === selected.toLowerCase());
        if (!block) throw new Error('errors.stlinkTargetUnknown');
        const chipId = /chipid\s*:\s*(0x[\da-f]+)/i.exec(block[2])?.[1];
        return {
          output,
          config: {
            ...config,
            programmer: {
              ...config.programmer!,
              serialNumber: selected,
              ...(chipId ? { targetChipId: chipId } : {}),
            },
          },
        };
      }
      const port = await host.requirePort(selection?.port || config.port);
      await host.closeSerial();
      const output = await run(
        await python(config),
        ['-m', 'esptool', '--chip', chip(config), '--port', port, 'flash-id'],
        45000,
      );
      return { output, config: { ...config, port } };
    },
    async build(config, inputs) {
      adapter.validateConfig(config);
      const output = await host.resetDirectory('.blode/build');
      const command = value(config, 'buildExecutable').trim();
      let log = '';
      let artifacts: string[];
      if (command) {
        log = await run(
          command,
          customBuildArguments(config, {
            root: host.projectRoot(),
            output,
            entry: inputs.entry ?? inputs.sketch ?? '.',
          }),
          900000,
        );
        const relative = value(config, 'firmware', 'build/firmware.bin');
        const source = await host.resolveWorkspacePath(relative);
        const target = path.join(output, 'firmware.bin');
        if (path.resolve(source) !== path.resolve(target)) await fs.copyFile(source, target);
        artifacts = ['.blode/build/firmware.bin'];
      } else if (stm) {
        const source = await host.resolveWorkspacePath(value(config, 'firmware', 'firmware.bin'));
        await fs.copyFile(source, path.join(output, 'firmware.bin'));
        artifacts = ['.blode/build/firmware.bin'];
      } else {
        // A dedicated sketch directory avoids changing the user's files.
        const all = await host.readProjectFiles();
        const entry = (inputs.entry ?? inputs.sketch ?? '').replaceAll('\\', '/');
        const entryPath =
          entry && entry !== '.' ? await host.resolveWorkspacePath(entry) : host.projectRoot();
        const entryStat = await fs.stat(entryPath);
        const prefix = entryStat.isDirectory()
          ? entry === '.'
            ? ''
            : entry
          : path.posix.dirname(entry).replace(/^\.$/, '');
        const files = all.filter(
          (file) =>
            (!prefix || file.path.startsWith(prefix + '/')) &&
            (!inputs.files?.length || inputs.files.includes(file.path) || file.path === entry),
        );
        const sketches = files.filter((file) => file.path.endsWith('.ino'));
        const main = entryStat.isFile()
          ? files.find((file) => file.path === entry)
          : sketches.length === 1
            ? sketches[0]
            : undefined;
        if (!main) throw new Error('error.selectBuildEntry');
        const stage = await host.resetDirectory('.blode/staging/firmware');
        for (const file of files) {
          const relative =
            file.path === main.path ? 'firmware.ino' : file.path.slice(prefix ? prefix.length + 1 : 0);
          const target = path.join(stage, relative);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(
            target,
            (/\.(?:ino|c|cpp|cc|cxx|h|hpp|s)$/i.test(file.path)
              ? `#line 1 ${JSON.stringify(file.path)}\n`
              : '') + file.content,
          );
        }
        const fqbn = adapter.getFqbn(config);
        if (!/^[-\w]+:[-\w]+:[-\w]+(?::[-\w=,.]+)?$/.test(fqbn)) throw new Error('errors.invalidFqbn');
        const regions = config.partitions.filter((region) => region.type !== 'system');
        for (const region of regions) {
          if (
            region.offset % (region.type === 'app' ? 0x10000 : 4096) ||
            region.size % 4096 ||
            !/^[a-zA-Z0-9_-]{1,16}$/.test(region.name)
          )
            throw new Error('errors.invalidPartition');
        }
        await fs.writeFile(
          path.join(stage, 'partitions.csv'),
          '# Name, Type, SubType, Offset, Size\n' +
            regions
              .map(
                (p) =>
                  `${p.name},${p.type === 'app' ? 'app' : 'data'},${
                    p.type === 'app'
                      ? 'factory'
                      : ((
                          { nvs: 'nvs', phy: 'phy', coredump: 'coredump', filesystem: 'spiffs' } as Record<
                            string,
                            string
                          >
                        )[p.id] ?? '0x40')
                  },0x${p.offset.toString(16)},0x${p.size.toString(16)}`,
              )
              .join('\n') +
            '\n',
        );
        const configFile = path.join(root, 'arduino-cli.yaml');
        const args = (await fs.stat(configFile).catch(() => null)) ? ['--config-file', configFile] : [];
        const libraryArgs = await Promise.all(
          (inputs.components?.arduinoLibraries ?? []).map((p) => host.resolveWorkspacePath(p)),
        );
        log = await run(
          cli(config),
          [
            ...args,
            'compile',
            '--fqbn',
            fqbn,
            '--warnings',
            'all',
            '--build-path',
            output,
            '--build-property',
            `upload.maximum_size=${config.partitions.find((p) => p.type === 'app')!.size}`,
            ...(inputs.settings?.mode === 'debug' ? ['--optimize-for-debug'] : []),
            ...libraryArgs.flatMap((p) => ['--libraries', p]),
            stage,
          ],
          900000,
        );
        artifacts = (await fs.readdir(output))
          .filter((file) => /^firmware\.ino(?:\.[\w-]+)?\.bin$/.test(file))
          .map((file) => '.blode/build/' + file);
      }
      const binary =
        artifacts.find((file) => file.endsWith('.ino.bin')) ??
        artifacts.find((file) => file.endsWith('firmware.bin'));
      if (!binary) throw new Error('error.noFirmware');
      const bytes = await fs.stat(await host.resolveWorkspacePath(binary, { internal: true }));
      const app = config.partitions.find((item) => item.type === 'app')!;
      if (!bytes.size || bytes.size > app.size) throw new Error('error.firmwareTooLarge');
      const ram = /Global variables use\s+([\d,]+)\s+bytes/i.exec(log);
      return {
        success: true,
        flashUsed: bytes.size,
        flashTotal: app.size,
        ramUsed: ram ? Number(ram[1].replaceAll(',', '')) : 0,
        ramTotal: customNumber(config, 'ramSize', adapter.definition.ramSize),
        artifacts,
        output: log,
        timestamp: new Date().toISOString(),
      };
    },
    async flash(config, result: BuildResult) {
      const image = result.artifacts.find(
        (file) => file.endsWith('firmware.bin') || file.endsWith('.ino.bin'),
      );
      if (!image) throw new Error('error.noFirmware');
      if (!stm && image.endsWith('.ino.bin')) {
        const port = await host.requirePort(config.port);
        await host.closeSerial();
        const args = [
          '-m',
          'esptool',
          '--chip',
          chip(config),
          '--port',
          port,
          '--baud',
          String(config.baudRate),
          'write-flash',
        ];
        for (const [file, address] of [
          [result.artifacts.find((p) => p.endsWith('.bootloader.bin')), customBootAddress(config)],
          [
            result.artifacts.find((p) => p.endsWith('.partitions.bin')),
            customNumber(config, 'partitionAddress', 0x8000),
          ],
          [image, config.partitions.find((p) => p.type === 'app')!.offset],
        ] as [string | undefined, number][]) {
          if (!file) throw new Error('firmware.incompleteBuild');
          const target = await host.resolveWorkspacePath(file, { internal: true });
          if (
            !Number.isSafeInteger(address) ||
            address < 0 ||
            address % 4096 ||
            address + (await fs.stat(target)).size > config.flashSize
          )
            throw new Error('errors.firmwareOutOfBounds');
          args.push('0x' + address.toString(16), target);
        }
        await run(await python(config), args, 180000);
      } else {
        const target = await host.resolveWorkspacePath(image, { internal: true });
        const data = await fs.readFile(target);
        await flashPrepared(config, {
          path: target,
          size: data.length,
          sha256: digest(data),
          address: customNumber(config, 'flashAddress', stm ? 0x08000000 : 0),
        });
      }
    },
    flashPrepared,
    invalidate() {},
  };
}
