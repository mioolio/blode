import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BuildResult, ProjectBuildInputs, ProjectConfig } from '../../../src/shared/contracts.js';
import type { RuntimeHost } from '../../runtime.js';
import {
  createF1GnuLinkerScript,
  createF1GnuStartup,
  createF1Scatter,
  createF1Startup,
  F1_MEDIUM_DENSITY,
} from './templates.js';
import { appRegionSize } from './layout.js';
import { STM32_FLASH_BASE } from './protocol.js';
import { parseKeilProject, type KeilInputs } from './keil.js';
import { migrateLegacyCmsis } from './cmsis.js';

const sourceExtensions = new Set(['.c', '.cpp', '.cc', '.cxx']);
const inputExtensions = new Set([
  ...sourceExtensions,
  '.h',
  '.hpp',
  '.hh',
  '.inc',
  '.s',
  '.S',
  '.sct',
  '.ld',
  '.uvprojx',
]);
const ignored = new Set(['node_modules', 'build', 'dist', 'out', 'objects', 'listings']);

interface CompilationInputs {
  sources: string[];
  headers: string[];
  assembly: string[];
  scatter: string[];
  all: string[];
  keil?: KeilInputs;
}

/** Arm Compiler 6 host integration; no project script or shell command is executed. */
export class Stm32Compiler {
  constructor(private readonly host: RuntimeHost) {}

  private async directory(config: ProjectConfig): Promise<string | null> {
    const supplied = config.toolchain.armCompilerDirectory;
    if (supplied && /[\r\n\0]/.test(supplied)) throw new Error('error.armCompilerMissing');
    const root = supplied
      ? path.resolve(supplied)
      : path.join(this.host.toolchainRoot ?? path.join(this.host.dataRoot, 'toolchains'), 'armclang');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const searchPath =
      this.host.env?.PATH ?? this.host.env?.Path ?? process.env.PATH ?? process.env.Path ?? '';
    const pathDirectories = supplied
      ? []
      : searchPath
          .split(path.delimiter)
          .map((item) => item.trim().replace(/^"(.*)"$/, '$1'))
          .filter((item) => item && path.isAbsolute(item));
    for (const directory of new Set([path.join(root, 'bin'), root, ...pathDirectories])) {
      const found = await Promise.all(
        ['armclang', 'armlink', 'fromelf'].map(async (name) => {
          const stat = await fs.lstat(path.join(directory, name + suffix)).catch(() => null);
          return !!stat?.isFile() && !stat.isSymbolicLink();
        }),
      );
      if (found.every(Boolean)) return directory;
    }
    return null;
  }

  /** GNU Arm Embedded lives beside the managed AC6 tools and is found through PATH as well. */
  private async gnuDirectory(config: ProjectConfig): Promise<string | null> {
    const supplied = config.toolchain.armCompilerDirectory?.trim();
    if (supplied && /[\r\n\0]/.test(supplied)) throw new Error('errors.stm32CompilerMissing');
    const root = path.join(this.host.toolchainRoot ?? path.join(this.host.dataRoot, 'toolchains'), 'armgcc');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const searchPath =
      this.host.env?.PATH ?? this.host.env?.Path ?? process.env.PATH ?? process.env.Path ?? '';
    const pathDirectories = supplied
      ? []
      : searchPath
          .split(path.delimiter)
          .map((item) => item.trim().replace(/^"(.*)"$/, '$1'))
          .filter((item) => item && path.isAbsolute(item));
    const suppliedDirectories = supplied
      ? [path.resolve(supplied), path.join(path.resolve(supplied), 'bin')]
      : [];
    for (const directory of new Set([
      ...suppliedDirectories,
      path.join(root, 'bin'),
      root,
      ...pathDirectories,
    ])) {
      const found = await Promise.all(
        ['arm-none-eabi-gcc', 'arm-none-eabi-objcopy'].map(async (name) => {
          const stat = await fs.lstat(path.join(directory, name + suffix)).catch(() => null);
          return !!stat?.isFile() && !stat.isSymbolicLink();
        }),
      );
      if (found.every(Boolean)) return directory;
    }
    return null;
  }

  private async resolveToolchain(
    config: ProjectConfig,
  ): Promise<{ kind: 'ac6' | 'gnu'; directory: string } | null> {
    // An installed Arm Compiler keeps Keil projects on their native toolchain.
    const ac6 = await this.directory(config);
    if (ac6) return { kind: 'ac6', directory: ac6 };
    const gnu = await this.gnuDirectory(config);
    if (gnu) return { kind: 'gnu', directory: gnu };
    return null;
  }

  async status(config: ProjectConfig): Promise<{ installed: boolean; version: string; gnu: boolean }> {
    const directory = await this.directory(config);
    if (directory) {
      try {
        const result = await this.host.runCommand(
          path.join(directory, this.executable('armclang')),
          ['--version'],
          {
            timeout: 10_000,
            signal: this.host.signal,
            env: this.host.env,
          },
        );
        return {
          installed: result.code === 0,
          version: /Arm Compiler for Embedded\s+([\d.]+)/i.exec(result.output)?.[1] ?? result.output.trim(),
          gnu: false,
        };
      } catch (error) {
        if (this.host.signal.aborted) throw error;
        return { installed: false, version: '', gnu: false };
      }
    }
    const gnuDirectory = await this.gnuDirectory(config);
    if (!gnuDirectory) return { installed: false, version: '', gnu: false };
    try {
      const result = await this.host.runCommand(
        path.join(gnuDirectory, this.executable('arm-none-eabi-gcc')),
        ['--version'],
        {
          timeout: 10_000,
          signal: this.host.signal,
          env: this.host.env,
        },
      );
      return {
        installed: result.code === 0,
        version: /(\d+\.\d+\.\d+)/.exec(result.output)?.[1] ?? result.output.trim(),
        gnu: true,
      };
    } catch (error) {
      if (this.host.signal.aborted) throw error;
      return { installed: false, version: '', gnu: false };
    }
  }

  private executable(name: string): string {
    return name + (process.platform === 'win32' ? '.exe' : '');
  }

  private async inputs(build: ProjectBuildInputs): Promise<CompilationInputs> {
    if (!build.entry) throw new Error('error.noBuildEntry');
    const root = this.host.projectRoot();
    const entry = build.entry === '.' ? root : await this.host.resolveWorkspacePath(build.entry);
    const entryInfo = await fs.lstat(entry);
    if (entryInfo.isSymbolicLink() || (!entryInfo.isFile() && !entryInfo.isDirectory()))
      throw new Error('error.invalidBuildEntry');
    if (entryInfo.isFile() && !sourceExtensions.has(path.extname(entry).toLowerCase()))
      throw new Error('error.invalidBuildEntry');
    const scope = entryInfo.isDirectory() ? entry : path.dirname(entry);
    const all: string[] = [];
    async function walk(directory: string, depth: number) {
      if (depth > 32 || all.length > 20_000) throw new Error('error.projectTooLarge');
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.name.startsWith('.') || ignored.has(item.name.toLowerCase())) continue;
        const full = path.join(directory, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) await walk(full, depth + 1);
        else if (item.isFile() && inputExtensions.has(path.extname(item.name).toLowerCase())) {
          const relative = path.relative(root, full).replaceAll('\\', '/');
          all.push(relative);
        }
      }
    }
    await walk(root, 0);
    all.sort();
    const projects = all.filter((file) => file.endsWith('.uvprojx'));
    if (projects.length > 1) throw new Error('error.keilTargetAmbiguous');
    const keil = projects.length
      ? parseKeilProject(
          await fs.readFile(await this.host.resolveWorkspacePath(projects[0]), 'utf8'),
          projects[0],
        )
      : undefined;
    if (keil) {
      if (!/^STM32F103(?:C8|CB|R8|RB|T8|TB)$/i.test(keil.device))
        throw new Error('error.stm32CompilerProfileRequired');
      for (const file of [
        ...keil.files,
        ...keil.includes.filter((p) => p !== '.'),
        ...(keil.scatter ? [keil.scatter] : []),
      ])
        await this.host.resolveWorkspacePath(file);
      for (const file of keil.files)
        if (!all.includes(file)) throw new Error('error.projectFileMissing ' + file);
    }
    // Authorize every discovered input through the same host boundary as an explicit entry.
    for (const relative of all) await this.host.resolveWorkspacePath(relative);
    const inScope = (relative: string) => {
      const contained = path.relative(scope, path.join(root, relative));
      return contained !== '..' && !contained.startsWith(`..${path.sep}`) && !path.isAbsolute(contained);
    };
    const declared = build.files?.length
      ? new Set(build.files.map((file) => file.replaceAll('\\', '/')))
      : keil
        ? new Set(keil.files)
        : null;
    if (declared)
      for (const relative of declared) {
        await this.host.resolveWorkspacePath(relative);
        if (!all.includes(relative)) throw new Error('error.projectFileMissing');
      }
    const selected = (relative: string) =>
      declared ? declared.has(relative) || path.join(root, relative) === entry : inScope(relative);
    const sources = all.filter(
      (relative) => sourceExtensions.has(path.extname(relative).toLowerCase()) && selected(relative),
    );
    if (!sources.length) throw new Error('error.noBuildSources');
    return {
      keil,
      sources,
      headers: all.filter((relative) => /\.(?:h|hh|hpp|inc)$/i.test(relative)),
      assembly: all.filter(
        (relative) =>
          /\.s$/i.test(relative) &&
          (declared ? selected(relative) : selected(relative) || /startup/i.test(path.basename(relative))),
      ),
      scatter: keil?.scatter
        ? [keil.scatter]
        : all.filter((relative) => /\.sct$/i.test(relative) && (!declared || declared.has(relative))),
      all,
    };
  }

  async buildInputs(build: ProjectBuildInputs): Promise<readonly string[]> {
    return build.entry ? (await this.inputs(build)).all : ['firmware.bin'];
  }
  async projectDevice(build: ProjectBuildInputs): Promise<string | null> {
    return build.entry ? ((await this.inputs(build)).keil?.device ?? null) : null;
  }

  async build(config: ProjectConfig, build: ProjectBuildInputs): Promise<BuildResult> {
    const chipId = config.programmer?.targetChipId
      ? Number.parseInt(config.programmer.targetChipId, 16)
      : F1_MEDIUM_DENSITY.chipId;
    if (chipId !== F1_MEDIUM_DENSITY.chipId) throw new Error('error.stm32CompilerProfileRequired');
    const tool = await this.resolveToolchain(config);
    if (!tool) throw new Error('errors.stm32CompilerMissing');
    const inputs = await this.inputs(build);
    if (inputs.keil)
      this.host.emit(
        `Keil target: ${inputs.keil.name}; device: ${inputs.keil.device}; source files: ${inputs.sources.length}`,
      );
    if (tool.kind === 'gnu') return this.buildGnu(config, inputs, tool.directory);
    try {
      return await this.buildAc6(config, inputs, tool.directory);
    } catch (error) {
      // A native startup needs armasm. When only that piece is missing and a
      // GNU compiler exists, the generated F1 startup can take over.
      if (!(error instanceof Error) || error.message !== 'error.armCompilerMissing') throw error;
      const gnu = await this.gnuDirectory(config);
      if (!gnu) throw error;
      this.host.emit('status.stm32UsingGnuStartup', 'warning');
      return this.buildGnu(config, inputs, gnu);
    }
  }

  private async buildAc6(
    config: ProjectConfig,
    inputs: CompilationInputs,
    directory: string,
  ): Promise<BuildResult> {
    if (inputs.scatter.length > 1) throw new Error('error.stm32ScatterAmbiguous');
    const appSize = appRegionSize(config);
    const outputDirectory = await this.host.resetDirectory('.blode/build');
    const objectDirectory = path.join(outputDirectory, 'objects');
    await fs.mkdir(objectDirectory);
    const output: string[] = [];
    const run = async (tool: string, args: string[], timeout = 60_000) => {
      const result = await this.host.runCommand(path.join(directory, this.executable(tool)), args, {
        timeout,
        signal: this.host.signal,
        env: this.host.env,
        cwd: this.host.projectRoot(),
        onLine: (line) => this.host.emit(line),
      });
      output.push(result.output);
      if (result.code !== 0) throw new Error(result.output || 'error.stm32CompileFailed');
      return result;
    };
    const includes = [
      ...new Set([
        this.host.projectRoot(),
        ...(inputs.keil?.includes.map((file) => path.join(this.host.projectRoot(), file)) ?? []),
        ...inputs.headers.map((file) => path.dirname(path.join(this.host.projectRoot(), file))),
        ...inputs.sources.map((file) => path.dirname(path.join(this.host.projectRoot(), file))),
      ]),
    ];
    const flags = [
      '--target=arm-arm-none-eabi',
      '-mcpu=cortex-m3',
      '-mthumb',
      '-mfloat-abi=soft',
      '-Os',
      '-g',
      '-ffunction-sections',
      '-fdata-sections',
      '-ffreestanding',
      '-fno-builtin',
      '-fno-common',
      '-DSTM32F10X_MD',
      ...(inputs.keil?.defines.map((value) => `-D${value}`) ?? []),
      ...includes.flatMap((include) => ['-I', include]),
    ];
    const objects: string[] = [];
    let firmwareTag = false;
    const compile = async (source: string, cxx = false) => {
      const object = path.join(objectDirectory, `${objects.length}.o`);
      await run('armclang', [
        // C++ needs hosted main naming and AC6's constructor runtime; exceptions
        // and RTTI stay disabled, as on typical embedded C++ builds.
        ...flags.filter((flag) => !cxx || flag !== '-ffreestanding'),
        ...(cxx ? ['-std=gnu++17', '-fno-exceptions', '-fno-rtti'] : ['-std=gnu11']),
        '-c',
        source,
        '-o',
        object,
      ]);
      objects.push(object);
    };
    for (const source of inputs.sources) {
      firmwareTag ||= (await fs.readFile(await this.host.resolveWorkspacePath(source), 'utf8')).includes(
        '.fwtag',
      );
      let compilePath = await this.host.resolveWorkspacePath(source);
      const migrated =
        path.basename(source).toLowerCase() === 'core_cm3.c'
          ? migrateLegacyCmsis(await fs.readFile(compilePath, 'utf8'))
          : null;
      if (migrated) {
        compilePath = path.join(outputDirectory, 'core_cm3_ac6.c');
        await fs.writeFile(compilePath, migrated);
        this.host.emit('status.cmsisAc6Compatibility', 'warning');
      }
      this.host.emit(`Compiling ${source}`);
      await compile(compilePath, /\.(?:cpp|cc|cxx)$/i.test(source));
    }
    const projectStartups: { file: string; native: boolean }[] = [];
    for (const source of inputs.assembly) {
      const full = await this.host.resolveWorkspacePath(source);
      const text = await fs.readFile(full, 'utf8');
      if (/startup|\bReset_Handler\b/i.test(source + '\n' + text)) {
        projectStartups.push({
          file: full,
          native: /\bAREA\s+RESET\b/i.test(text) && /\bEXPORT\s+Reset_Handler\b/i.test(text),
        });
      } else {
        const object = path.join(objectDirectory, `${objects.length}.o`);
        await run('armclang', [...flags, '-c', full, '-o', object]);
        objects.push(object);
      }
    }
    const native = projectStartups.filter((startup) => startup.native);
    if (native.length > 1)
      throw new Error(
        'error.stm32StartupAmbiguous ' +
          native.map((item) => path.relative(this.host.projectRoot(), item.file)).join(', '),
      );
    let scatter: string;
    const useNative = native.length > 0 && (inputs.scatter.length > 0 || !!inputs.keil);
    if (useNative) {
      if (inputs.scatter.length) scatter = await this.host.resolveWorkspacePath(inputs.scatter[0]);
      else {
        scatter = path.join(outputDirectory, 'stm32_keil.sct');
        await fs.writeFile(scatter, createF1Scatter(config.flashSize, firmwareTag, true));
      }
      // armlink can execute the command in a scatter-file #! line. This
      // compiler integration only runs the fixed, explicitly selected tools.
      if (/^\s*#!/m.test(await fs.readFile(scatter, 'utf8')))
        throw new Error('error.stm32ScatterPreprocessor');
      const assembler = await fs.lstat(path.join(directory, this.executable('armasm'))).catch(() => null);
      if (!assembler?.isFile() || assembler.isSymbolicLink()) throw new Error('error.armCompilerMissing');
      const object = path.join(objectDirectory, `${objects.length}.o`);
      await run('armasm', ['--cpu=Cortex-M3', '--debug', native[0].file, '-o', object]);
      objects.push(object);
    } else {
      if (inputs.scatter.length || projectStartups.length || inputs.all.some((file) => file.endsWith('.ld')))
        this.host.emit('status.stm32UsingF1Startup', 'warning');
      const startup = path.join(outputDirectory, 'startup_f1_md.c');
      scatter = path.join(outputDirectory, 'stm32_f1_md.sct');
      await fs.writeFile(startup, createF1Startup());
      await fs.writeFile(scatter, createF1Scatter(config.flashSize, firmwareTag));
      await compile(startup);
    }
    const elf = path.join(outputDirectory, 'firmware.elf');
    const binary = path.join(outputDirectory, 'firmware.bin');
    await run('armlink', [
      '--cpu=Cortex-M3',
      '--entry=Reset_Handler',
      '--scatter',
      scatter,
      '--map',
      '--list',
      path.join(outputDirectory, 'firmware.map'),
      '--info=sizes',
      '--datacompressor=off',
      useNative ? '--keep=*(RESET)' : '--keep=*(.isr_vector)',
      ...(firmwareTag ? ['--keep=*(.fwtag)'] : []),
      ...objects,
      '-o',
      elf,
    ]);
    const stackReserve = useNative ? 0 : F1_MEDIUM_DENSITY.stackSize;
    const usage = inspectStm32Elf(
      await fs.readFile(elf),
      config.flashSize,
      F1_MEDIUM_DENSITY.ramSize,
      stackReserve,
    );
    await run('fromelf', ['--bin', '--output', binary, elf]);
    const bytes = await fs.readFile(binary);
    validateStm32Binary(bytes, config.flashSize, F1_MEDIUM_DENSITY.ramSize);
    const flashUsed = Math.max(bytes.length, usage.flashUsed);
    const overlapped = config.partitions.filter(
      (partition) => partition.type !== 'app' && partition.offset < flashUsed,
    );
    const warnings = [
      ...(flashUsed > appSize
        ? [`WARNING: firmware exceeds the application region (${flashUsed} > ${appSize} bytes).`]
        : []),
      ...(overlapped.length
        ? [`WARNING: firmware overlaps reserved regions: ${overlapped.map((item) => item.name).join(', ')}.`]
        : []),
    ];
    return {
      success: true,
      flashUsed,
      ramUsed: usage.ramUsed,
      flashTotal: appSize,
      ramTotal: F1_MEDIUM_DENSITY.ramSize,
      artifacts: ['.blode/build/firmware.bin'],
      timestamp: new Date().toISOString(),
      output: `${output.join('\n')}\nFlash application usage: ${flashUsed} / ${appSize} bytes\nSRAM usage: ${usage.ramUsed} / ${F1_MEDIUM_DENSITY.ramSize} bytes\nSRAM allocation includes ${stackReserve} bytes reserved for the descending stack.${warnings.length ? `\n${warnings.join('\n')}` : ''}`,
    };
  }

  /**
   * GNU Arm build: generated startup and linker script keep the partition
   * boundary authoritative. Project ARM-syntax startup/scatter files are
   * ignored because GNU as and ld cannot consume them.
   */
  private async buildGnu(
    config: ProjectConfig,
    inputs: CompilationInputs,
    directory: string,
  ): Promise<BuildResult> {
    const appSize = appRegionSize(config);
    const outputDirectory = await this.host.resetDirectory('.blode/build');
    const objectDirectory = path.join(outputDirectory, 'objects');
    await fs.mkdir(objectDirectory);
    const gcc = path.join(directory, this.executable('arm-none-eabi-gcc'));
    const objcopy = path.join(directory, this.executable('arm-none-eabi-objcopy'));
    const output: string[] = [];
    const run = async (command: string, args: string[], timeout = 60_000) => {
      const result = await this.host.runCommand(command, args, {
        timeout,
        signal: this.host.signal,
        env: this.host.env,
        cwd: this.host.projectRoot(),
        onLine: (line) => this.host.emit(line),
      });
      output.push(result.output);
      if (result.code !== 0) throw new Error(result.output || 'error.stm32CompileFailed');
      return result;
    };
    const includes = [
      ...new Set([
        this.host.projectRoot(),
        ...(inputs.keil?.includes.map((file) => path.join(this.host.projectRoot(), file)) ?? []),
        ...inputs.headers.map((file) => path.dirname(path.join(this.host.projectRoot(), file))),
        ...inputs.sources.map((file) => path.dirname(path.join(this.host.projectRoot(), file))),
      ]),
    ];
    const flags = [
      '-mcpu=cortex-m3',
      '-mthumb',
      '-mfloat-abi=soft',
      '-Os',
      '-g',
      '-ffunction-sections',
      '-fdata-sections',
      '-ffreestanding',
      '-fno-builtin',
      '-fno-common',
      '-DSTM32F10X_MD',
      ...(inputs.keil?.defines.map((value) => `-D${value}`) ?? []),
      ...includes.flatMap((include) => ['-I', include]),
    ];
    const objects: string[] = [];
    let firmwareTag = false;
    const compile = async (source: string, cxx = false) => {
      const object = path.join(objectDirectory, `${objects.length}.o`);
      await run(gcc, [
        ...flags,
        ...(cxx ? ['-std=gnu++17', '-fno-exceptions', '-fno-rtti'] : ['-std=gnu11']),
        '-c',
        source,
        '-o',
        object,
      ]);
      objects.push(object);
    };
    for (const source of inputs.sources) {
      const full = await this.host.resolveWorkspacePath(source);
      const text = await fs.readFile(full, 'utf8');
      firmwareTag ||= text.includes('.fwtag');
      let compilePath = full;
      const migrated =
        path.basename(source).toLowerCase() === 'core_cm3.c' ? migrateLegacyCmsis(text, '__asm__') : null;
      if (migrated) {
        compilePath = path.join(outputDirectory, 'core_cm3_gnu.c');
        await fs.writeFile(compilePath, migrated);
        this.host.emit('status.cmsisGnuCompatibility', 'warning');
      }
      this.host.emit(`Compiling ${source}`);
      await compile(compilePath, /\.(?:cpp|cc|cxx)$/i.test(source));
    }
    const projectStartups: { file: string; native: boolean }[] = [];
    for (const source of inputs.assembly) {
      const full = await this.host.resolveWorkspacePath(source);
      const text = await fs.readFile(full, 'utf8');
      if (/startup|\bReset_Handler\b/i.test(source + '\n' + text)) {
        projectStartups.push({
          file: full,
          native: /\bAREA\s+RESET\b/i.test(text) && /\bEXPORT\s+Reset_Handler\b/i.test(text),
        });
      } else {
        const object = path.join(objectDirectory, `${objects.length}.o`);
        await run(gcc, [...flags, '-c', full, '-o', object]);
        objects.push(object);
      }
    }
    if (projectStartups.length || inputs.scatter.length || inputs.all.some((file) => file.endsWith('.ld')))
      this.host.emit('status.stm32UsingGnuStartup', 'warning');
    const startup = path.join(outputDirectory, 'startup_f1_md.c');
    const linker = path.join(outputDirectory, 'stm32_f1_md.ld');
    await fs.writeFile(startup, createF1GnuStartup());
    await fs.writeFile(linker, createF1GnuLinkerScript(config.flashSize, firmwareTag));
    await compile(startup);
    const elf = path.join(outputDirectory, 'firmware.elf');
    const binary = path.join(outputDirectory, 'firmware.bin');
    await run(gcc, [
      ...flags,
      '-T',
      linker,
      '-Wl,--gc-sections',
      `-Wl,-Map=${path.join(outputDirectory, 'firmware.map')}`,
      '-Wl,--print-memory-usage',
      '-specs=nosys.specs',
      '-specs=nano.specs',
      ...objects,
      '-o',
      elf,
    ]);
    const usage = inspectStm32Elf(await fs.readFile(elf), config.flashSize, F1_MEDIUM_DENSITY.ramSize);
    await run(objcopy, ['-O', 'binary', elf, binary]);
    const bytes = await fs.readFile(binary);
    validateStm32Binary(bytes, config.flashSize, F1_MEDIUM_DENSITY.ramSize);
    const flashUsed = Math.max(bytes.length, usage.flashUsed);
    const overlapped = config.partitions.filter(
      (partition) => partition.type !== 'app' && partition.offset < flashUsed,
    );
    const warnings = [
      ...(flashUsed > appSize
        ? [`WARNING: firmware exceeds the application region (${flashUsed} > ${appSize} bytes).`]
        : []),
      ...(overlapped.length
        ? [`WARNING: firmware overlaps reserved regions: ${overlapped.map((item) => item.name).join(', ')}.`]
        : []),
    ];
    return {
      success: true,
      flashUsed,
      ramUsed: usage.ramUsed,
      flashTotal: appSize,
      ramTotal: F1_MEDIUM_DENSITY.ramSize,
      artifacts: ['.blode/build/firmware.bin'],
      timestamp: new Date().toISOString(),
      output: `${output.join('\n')}\nCompiler: GNU Arm GCC (arm-none-eabi)\nFlash application usage: ${flashUsed} / ${appSize} bytes\nSRAM usage: ${usage.ramUsed} / ${F1_MEDIUM_DENSITY.ramSize} bytes\nSRAM allocation includes ${F1_MEDIUM_DENSITY.stackSize} bytes reserved for the descending stack.${warnings.length ? `\n${warnings.join('\n')}` : ''}`,
    };
  }
}

/** Inspect the actual ARM ELF load ranges rather than estimating source-code usage. */
export function inspectStm32Elf(
  bytes: Buffer,
  appSize: number,
  ramSize: number,
  stackReserve = 0,
): { flashUsed: number; ramUsed: number } {
  if (
    bytes.length < 52 ||
    bytes.toString('hex', 0, 4) !== '7f454c46' ||
    bytes[4] !== 1 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(16) !== 2 ||
    bytes.readUInt16LE(18) !== 40
  )
    throw new Error('error.stm32InvalidElf');
  const offset = bytes.readUInt32LE(28),
    stride = bytes.readUInt16LE(42),
    count = bytes.readUInt16LE(44);
  if (stride < 32 || !count || offset + stride * count > bytes.length)
    throw new Error('error.stm32InvalidElf');
  let flashUsed = 0,
    firstLoad = Infinity;
  for (let index = 0; index < count; index++) {
    const base = offset + index * stride;
    if (bytes.readUInt32LE(base) !== 1) continue;
    const physical = bytes.readUInt32LE(base + 12);
    const fileSize = bytes.readUInt32LE(base + 16);
    if (fileSize) {
      if (physical < STM32_FLASH_BASE || physical + fileSize > STM32_FLASH_BASE + appSize)
        throw new Error('errors.firmwareOutOfBounds');
      flashUsed = Math.max(flashUsed, physical + fileSize - STM32_FLASH_BASE);
      firstLoad = Math.min(firstLoad, physical);
    }
  }
  if (!flashUsed || firstLoad !== STM32_FLASH_BASE) throw new Error('error.stm32InvalidElf');
  // armlink's single PT_LOAD describes the load region, not separate SRAM
  // execution addresses. SHF_ALLOC sections carry the authoritative RW/ZI use.
  const sectionOffset = bytes.readUInt32LE(32),
    sectionStride = bytes.readUInt16LE(46),
    sectionCount = bytes.readUInt16LE(48);
  if (sectionStride < 40 || !sectionCount || sectionOffset + sectionStride * sectionCount > bytes.length)
    throw new Error('error.stm32InvalidElf');
  const ramRanges: [number, number][] = [];
  if (stackReserve) ramRanges.push([0x20000000 + ramSize - stackReserve, 0x20000000 + ramSize]);
  for (let index = 0; index < sectionCount; index++) {
    const base = sectionOffset + index * sectionStride;
    const flags = bytes.readUInt32LE(base + 8),
      address = bytes.readUInt32LE(base + 12),
      size = bytes.readUInt32LE(base + 20);
    if (!(flags & 2) || !size) continue;
    if (address >= 0x20000000 && address < 0x30000000) {
      if (address + size > 0x20000000 + ramSize) throw new Error('error.stm32RamOutOfBounds');
      ramRanges.push([address, address + size]);
    }
  }
  ramRanges.sort((left, right) => left[0] - right[0]);
  let ramUsed = 0,
    end = 0;
  for (const [start, limit] of ramRanges) {
    ramUsed += Math.max(0, limit - Math.max(start, end));
    end = Math.max(end, limit);
  }
  return { flashUsed, ramUsed };
}

export function validateStm32Binary(bytes: Buffer, appSize: number, ramSize: number): void {
  if (bytes.length < 8 || bytes.length > appSize) throw new Error('error.firmwareTooLarge');
  const stack = bytes.readUInt32LE(0),
    reset = bytes.readUInt32LE(4);
  if (
    stack <= 0x20000000 ||
    stack > 0x20000000 + ramSize ||
    stack % 4 ||
    !(reset & 1) ||
    (reset & ~1) < STM32_FLASH_BASE ||
    (reset & ~1) >= STM32_FLASH_BASE + bytes.length
  )
    throw new Error('error.stm32InvalidVector');
}
