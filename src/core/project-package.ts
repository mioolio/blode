import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DOMParser } from '../../extensions/boards/STM32F103C8T6/compiler/vendor/xml.cjs';
import { writeZip, type ZipEntry } from './zip';
import { readBuildDependencies, type BuildEvidenceStatus } from './build-dependencies';
import type { ProjectPackagePlan, ProjectPackageResult, PackageWarning } from '../shared/project-package';

const skipped = new Set([
  '.git',
  'node_modules',
  '.blode',
  '.blode-share',
  '.tools',
  '.signing',
  'tools',
  'build',
  'dist',
  '.cache',
  'release',
]);
const privateEntry = (name: string) =>
  /^(?:\.signing|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.gnupg|model-credentials|model-service\.json|.*\.credential)$/i.test(
    name,
  ) && !/^\.env\.(?:example|sample|template)$/i.test(name);
const textExtensions = new Set([
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.s',
  '.S',
  '.ino',
  '.uvprojx',
  '.json',
  '.txt',
  '.cmake',
  '.mk',
  '.sct',
  '.ld',
]);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');
const isTextFile = (file: string) =>
  textExtensions.has(path.extname(file).toLowerCase()) || /^Makefile$/i.test(path.basename(file));
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
};
const xmlEscape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
interface Scanned {
  plan: ProjectPackagePlan;
  content: Map<string, Buffer>;
  paths: Map<string, string>;
  directories: Map<string, string>;
}

/** Snapshot the original files, collect declared dependencies and rewrite only the exported copy. */
export async function collectProjectPackage(
  projectRoot: string,
  options: { toolchainRoots?: string[]; privateRoots?: string[]; buildEvidence?: BuildEvidenceStatus } = {},
): Promise<Scanned> {
  if (!projectRoot) throw new Error('error.noWorkspace');
  const root = await fs.realpath(projectRoot);
  const paths = new Map<string, string>(),
    directories = new Map<string, string>(),
    content = new Map<string, Buffer>();
  const aliases = new Map<string, string>();
  const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const canonical = (value: string) => aliases.get(key(value)) ?? value;
  const warnings: PackageWarning[] = [];
  const includes: string[] = [];
  const evidence = await readBuildDependencies(root, options.buildEvidence);
  const canonicalRoots = async (values: string[]) =>
    Promise.all(
      values
        .filter(Boolean)
        .map(async (value) => fs.realpath(path.resolve(value)).catch(() => path.resolve(value))),
    );
  const toolRoots = (
    await canonicalRoots([
      ...(options.toolchainRoots ?? []),
      ...(options.buildEvidence?.records?.flatMap((record) => record.toolchainRoots ?? []) ?? []),
    ])
  ).filter((directory) => directory !== root);
  const privateRoots = (await canonicalRoots(options.privateRoots ?? [])).filter(
    (directory) => directory !== root,
  );
  const suppliedByTool = (file: string) =>
    toolRoots.some((directory) => inside(directory, file)) &&
    (!inside(root, file) ||
      slash(path.relative(root, file))
        .split('/')
        .some((part) => skipped.has(part)));
  const supplied = new Set<string>(),
    detectedTools = new Set<string>();
  const queued: string[] = [];
  let total = 0;
  const externalRoot = (directory: string) => {
    if (inside(root, directory)) return slash(path.relative(root, directory)) || '.';
    let mapped = directories.get(directory);
    if (!mapped) {
      mapped = `dependencies/${hash(directory).slice(0, 10)}-${path.basename(directory).replace(/[^\p{L}\p{N}_.-]/gu, '_') || 'external'}`;
      directories.set(directory, mapped);
    }
    return mapped;
  };
  const mapped = (file: string) => {
    if (inside(root, file)) return slash(path.relative(root, file));
    const parent =
      [...directories.keys()].filter((dir) => inside(dir, file)).sort((a, b) => b.length - a.length)[0] ??
      path.dirname(file);
    return externalRoot(parent) + '/' + slash(path.relative(parent, file));
  };
  const add = async (file: string) => {
    let real: string;
    try {
      real = await fs.realpath(file);
    } catch {
      warnings.push({ file: '', reference: file, reason: 'missing' });
      return;
    }
    aliases.set(key(file), real);
    if (
      privateRoots.some((directory) => inside(directory, real)) ||
      real.split(path.sep).some((part) => privateEntry(part))
    ) {
      warnings.push({ file: '', reference: path.basename(real), reason: 'private-dependency' });
      return;
    }
    if (suppliedByTool(real)) {
      supplied.add(slash(real));
      const core = /\/packages\/([^/]+)\/hardware\/([^/]+)\/([^/]+)/.exec(slash(real));
      detectedTools.add(core ? `arduino-core:${core[1]}:${core[2]}@${core[3]}` : 'platform-toolchain');
      return;
    }
    if (paths.has(real)) return;
    const stat = await fs.stat(real);
    if (!stat.isFile()) return;
    if (stat.size > 64 * 1024 * 1024 || total + stat.size > 256 * 1024 * 1024 || paths.size >= 9990)
      throw new Error('error.packageTooLarge');
    const bytes = await fs.readFile(real);
    total += bytes.length;
    paths.set(real, mapped(real));
    content.set(real, bytes);
    queued.push(real);
  };
  const visited = new Set<string>();
  const walk = async (directory: string, depth = 0) => {
    if (depth > 24) throw new Error('error.packageTooLarge');
    const real = await fs.realpath(directory);
    if (privateRoots.some((directory) => inside(directory, real))) return;
    aliases.set(key(directory), real);
    if (visited.has(real)) return;
    visited.add(real);
    if (suppliedByTool(real)) {
      includes.push(real);
      detectedTools.add('platform-toolchain');
      return;
    }
    for (const entry of await fs.readdir(real, { withFileTypes: true })) {
      if (skipped.has(entry.name) || privateEntry(entry.name)) continue;
      const full = path.join(real, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push({ file: slash(path.relative(root, real)), reference: entry.name, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) await add(full);
    }
  };
  await walk(root);
  warnings.push(...evidence.warnings);
  includes.push(...evidence.includeDirectories);
  for (const dependency of evidence.files) {
    if (suppliedByTool(dependency)) {
      supplied.add(slash(dependency));
      const core = /\/packages\/([^/]+)\/hardware\/([^/]+)\/([^/]+)/.exec(slash(dependency));
      if (core) detectedTools.add(`arduino-core:${core[1]}:${core[2]}@${core[3]}`);
      else detectedTools.add('platform-toolchain');
      continue;
    }
    if (!inside(root, dependency)) externalRoot(path.dirname(dependency));
    if (/\.(?:h|hpp|hh|hxx)$/i.test(dependency)) includes.push(path.dirname(dependency));
    await add(dependency);
  }
  // Explicit Keil metadata supplies source and include directories even when they live outside the project.
  for (const [file, bytes] of [...content])
    if (file.toLowerCase().endsWith('.uvprojx')) {
      const xml = bytes.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('error.keilProjectInvalid');
      const doc = new DOMParser({
        errorHandler: {
          warning: () => {},
          error: () => {},
          fatalError: () => {
            throw new Error('error.keilProjectInvalid');
          },
        },
      }).parseFromString(xml, 'text/xml');
      for (const tag of ['IncludePath', 'FilePath', 'ScatterFile'])
        for (const node of Array.from(doc.getElementsByTagName(tag))) {
          for (const reference of (node.textContent ?? '')
            .split(tag === 'IncludePath' ? ';' : '\0')
            .map((value) => value.trim())
            .filter(Boolean)) {
            if (/[$\r\n]/.test(reference)) {
              warnings.push({ file: mapped(file), reference, reason: 'variable' });
              continue;
            }
            const logical = path.resolve(path.dirname(file), reference.replaceAll('\\', path.sep));
            const target = await fs.realpath(logical).catch(() => logical);
            aliases.set(key(logical), target);
            const stat = await fs.stat(target).catch(() => null);
            if (!stat) {
              warnings.push({ file: mapped(file), reference, reason: 'missing' });
              continue;
            }
            if (stat.isDirectory()) {
              externalRoot(target);
              includes.push(target);
              await walk(target);
            } else {
              externalRoot(path.dirname(target));
              await add(target);
            }
          }
        }
    }
  const descriptors = new Map<string, Record<string, any>>();
  for (const [file, bytes] of content)
    if (path.basename(file) === 'be') {
      try {
        const descriptor = JSON.parse(bytes.toString('utf8'));
        if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error();
        descriptors.set(file, descriptor);
      } catch {
        throw new Error('error.invalidProjectDescriptor');
      }
    }
  const declaredBuilds = [...descriptors].flatMap(([file, descriptor]) => [
    { file, base: path.dirname(file), build: descriptor.build },
    ...(Array.isArray(descriptor.build?.targets)
      ? descriptor.build.targets.map((target: any) => ({
          file,
          base: path.resolve(path.dirname(file), target.root),
          build: target.build,
        }))
      : []),
  ]);
  for (const { file, base, build } of declaredBuilds)
    if (build) {
      if (!inside(root, base)) throw new Error('error.invalidProjectDescriptor');
      for (const reference of [
        build.entry,
        build.sketch,
        ...(Array.isArray(build.files) ? build.files : []),
      ].filter((value) => typeof value === 'string')) {
        const logical = path.resolve(base, reference);
        const target = await fs.realpath(logical).catch(() => logical);
        aliases.set(key(logical), target);
        const stat = await fs.stat(target).catch(() => null);
        if (!stat) {
          warnings.push({ file: mapped(file), reference, reason: 'missing' });
          continue;
        }
        if (stat.isDirectory()) {
          externalRoot(target);
          await walk(target);
        } else await add(target);
      }
    }
  const resolveInclude = async (file: string, reference: string) => {
    const raw = reference.replaceAll('\\', path.sep);
    const actual = evidence.dependenciesByFile
      .get(key(file))
      ?.filter((dependency) => key(slash(dependency)).endsWith(key('/' + slash(raw))));
    if (actual?.length === 1) return await fs.realpath(actual[0]).catch(() => null);
    for (const candidate of [
      path.resolve(path.dirname(file), raw),
      ...includes.map((dir) => path.resolve(dir, raw)),
    ]) {
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) return await fs.realpath(candidate);
    }
    return null;
  };
  const macroIncludes = new Map<string, Map<string, string>>();
  for (let index = 0; index < queued.length; index++) {
    const file = queued[index],
      bytes = content.get(file)!;
    if (!isTextFile(file) || bytes.length > 2_000_000) continue;
    const source = bytes.toString('utf8');
    const definitions = [...source.matchAll(/^\s*#\s*(?:define|undef)\s+([A-Za-z_]\w*)\b/gm)];
    const constants = new Map(
      [...source.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)\s+["<]([^"<>\r\n]+)[">]\s*(?:\/\/[^\r\n]*)?$/gm)]
        .filter((match) => definitions.filter((definition) => definition[1] === match[1]).length === 1)
        .map((match) => [match[1], match[2]]),
    );
    for (const match of source.matchAll(/^\s*#\s*include\s+([A-Za-z_]\w*)/gm)) {
      const reference = constants.get(match[1]),
        target = reference ? await resolveInclude(file, reference) : null;
      if (target) {
        await add(target);
        const macros = macroIncludes.get(file) ?? new Map<string, string>();
        macros.set(match[1], target);
        macroIncludes.set(file, macros);
      } else warnings.push({ file: mapped(file), reference: match[1], reason: 'macro-include' });
    }
    for (const match of bytes.toString('utf8').matchAll(/^\s*#\s*include\s*(["<])([^"<>\r\n]+)[">]/gm)) {
      const target = await resolveInclude(file, match[2]);
      if (target) await add(target);
      else if (
        ![...supplied].some((file) => file.endsWith('/' + slash(match[2]))) &&
        (match[1] === '"' || /[\\/]/.test(match[2]))
      )
        warnings.push({ file: mapped(file), reference: match[2], reason: 'missing-include' });
    }
  }
  // Recompute maps once all explicit directory roots are known.
  for (const file of paths.keys()) paths.set(file, mapped(file));
  const relative = (from: string, target: string) =>
    path.posix.relative(path.posix.dirname(paths.get(from)!), target) || '.';
  for (const [file, bytes] of content) {
    if (!isTextFile(file) || bytes.length > 2_000_000) continue;
    let text = bytes.toString('utf8');
    for (const [name, target] of macroIncludes.get(file) ?? [])
      if (paths.has(target))
        text = text.replace(
          new RegExp('(^\\s*#\\s*include\\s+)' + name + '\\b', 'gm'),
          (_all, prefix: string) => prefix + '"' + relative(file, paths.get(target)!) + '"',
        );
    const matches = [...text.matchAll(/(^\s*#\s*include\s*)["<]([^"<>\r\n]+)[">]/gm)];
    for (const match of matches.reverse()) {
      const target = await resolveInclude(file, match[2]);
      if (!target || !paths.has(target)) continue;
      const replacement = match[1] + '"' + relative(file, paths.get(target)!) + '"';
      text = text.slice(0, match.index) + replacement + text.slice(match.index! + match[0].length);
    }
    if (file.toLowerCase().endsWith('.uvprojx')) {
      text = text.replace(
        /<(IncludePath|FilePath|ScatterFile)>([\s\S]*?)<\/\1>/g,
        (all, tag: string, value: string) => {
          const decoded = value
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&quot;', '"');
          return (
            `<${tag}>` +
            decoded
              .split(tag === 'IncludePath' ? ';' : '\0')
              .map((reference) => {
                const target = canonical(
                  path.resolve(path.dirname(file), reference.trim().replaceAll('\\', path.sep)),
                );
                const destination =
                  paths.get(target) ??
                  (inside(root, target)
                    ? slash(path.relative(root, target)) || '.'
                    : directories.get(target));
                return destination ? xmlEscape(relative(file, destination)) : xmlEscape(reference);
              })
              .join(tag === 'IncludePath' ? ';' : '') +
            `</${tag}>`
          );
        },
      );
    }
    if (/(?:CMakeLists\.txt|\.cmake|Makefile|\.mk)$/i.test(file)) {
      const cmake = /(?:CMakeLists\.txt|\.cmake)$/i.test(file);
      const prefix = cmake ? '${CMAKE_CURRENT_LIST_DIR}/' : '$(BLODE_PACKAGE_DIR)/';
      const replacements = new Map<string, string>();
      for (const [source, destination] of [...directories, ...paths])
        for (const spelling of new Set([source, slash(source), source.replaceAll('\\', '\\\\')]))
          replacements.set(spelling, prefix + relative(file, destination));
      let changed = false;
      for (const [source, destination] of [...replacements].sort(([a], [b]) => b.length - a.length)) {
        const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(
          new RegExp('(^|[\\s"\'(=;])' + escaped + '(?=$|[\\s"\');])', 'gm'),
          (_all, before: string) => {
            changed = true;
            return before + destination;
          },
        );
      }
      if (changed && !cmake)
        text = 'BLODE_PACKAGE_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))\n' + text;
    }
    if (
      /(?:CMakeLists\.txt|\.cmake|Makefile|\.mk)$/i.test(file) &&
      /(?:[A-Za-z]:[\\/]|\/home\/|\/opt\/)/.test(text)
    )
      warnings.push({
        file: paths.get(file)!,
        reference: 'absolute build paths',
        reason: 'manual-build-configuration',
      });
    content.set(file, Buffer.from(text));
  }
  const toolRequirements: string[] = [...detectedTools];
  const recordToolPath = (value: string, label: string) => {
    const version = /[\\/]versions[\\/](gnu-arm|arduino-cli|arduino-esp32)[\\/]([^\\/]+)/.exec(value);
    toolRequirements.push(version ? `${version[1]}:${version[2]}` : `custom:${label}`);
  };
  const portableCompilerChoice = (value: unknown, scope: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const choice = value as Record<string, unknown>;
    if (typeof choice.family === 'string' && !['inherit', 'auto'].includes(choice.family)) {
      const version = typeof choice.version === 'string' && choice.version ? `:${choice.version}` : '';
      toolRequirements.push(`compiler:${scope}:${choice.family}${version}`);
    }
    for (const field of ['directory', 'arduinoCli', 'packageDirectory']) {
      const location = choice[field];
      if (typeof location !== 'string' || !location) continue;
      recordToolPath(location, `build.settings.${scope}.${field}`);
      if (path.isAbsolute(location) || path.win32.isAbsolute(location)) delete choice[field];
    }
  };
  const portableBuild = (build: Record<string, any> | undefined, base: string) => {
    if (!build) return;
    const baseDestination = inside(root, base) ? slash(path.relative(root, base)) : directories.get(base);
    for (const field of ['entry', 'sketch', 'files']) {
      const rewrite = (reference: string) => {
        if (typeof reference !== 'string') return reference;
        const target = canonical(path.resolve(base, reference));
        const destination =
          paths.get(target) ??
          (inside(root, target) ? slash(path.relative(root, target)) || '.' : directories.get(target));
        return destination !== undefined && baseDestination !== undefined
          ? path.posix.relative(baseDestination || '.', destination) || '.'
          : reference;
      };
      if (Array.isArray(build[field])) build[field] = build[field].map(rewrite);
      else if (typeof build[field] === 'string') build[field] = rewrite(build[field]);
    }
    const settings = build.settings;
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      portableCompilerChoice(settings.common, 'common');
      for (const [platform, choices] of Object.entries(settings.platforms ?? {})) {
        if (!choices || typeof choices !== 'object' || Array.isArray(choices)) continue;
        for (const language of ['common', 'c', 'cpp'])
          portableCompilerChoice(
            (choices as Record<string, unknown>)[language],
            `platforms.${platform}.${language}`,
          );
      }
    }
  };
  const portableConfig = (config: Record<string, any>, full = false) => {
    if (config.toolchain)
      for (const field of [
        'armCompilerDirectory',
        'stlinkDirectory',
        'arduinoCli',
        'python',
        'packageDirectory',
      ]) {
        const value = config.toolchain[field];
        if (typeof value !== 'string' || !value) continue;
        recordToolPath(value, field);
        if (path.isAbsolute(value) || path.win32.isAbsolute(value)) delete config.toolchain[field];
      }
    if (full || config.toolchain) {
      config.toolchain ??= {};
      config.toolchain.arduinoCli ??= '';
      config.toolchain.python ??= '';
    }
    if (typeof config.port === 'string') config.port = '';
    if (config.runtime?.deviceId) delete config.runtime.deviceId;
    if (config.programmer?.serialNumber) config.programmer.serialNumber = '';
    if (config.debugger) {
      for (const field of ['gdbPath', 'serverPath', 'scriptsPath']) {
        const value = config.debugger[field];
        if (typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))) {
          recordToolPath(value, `debugger.${field}`);
          delete config.debugger[field];
        }
      }
      if (config.debugger.port) config.debugger.port = '';
      if (config.debugger.serialNumber) config.debugger.serialNumber = '';
    }
  };
  for (const [file, descriptor] of descriptors) {
    const base = path.dirname(file);
    portableBuild(descriptor.build, base);
    portableConfig(descriptor, true);
    for (const target of descriptor.build?.targets ?? []) {
      const sourceRoot = path.resolve(base, target.root);
      portableBuild(target.build, sourceRoot);
      if (target.config) portableConfig(target.config);
    }
    content.set(file, Buffer.from(JSON.stringify(descriptor, null, 2) + '\n'));
  }
  const files = [...paths].map(([source, destination]) => ({
    source,
    destination,
    external: !inside(root, source),
    size: content.get(source)!.length,
  }));
  const distinct = new Set(files.map((file) => file.destination.toLowerCase()));
  if (distinct.size !== files.length) throw new Error('error.packagePathCollision');
  return {
    plan: {
      projectRoot: root,
      name: path.basename(root),
      files,
      warnings,
      externalCount: files.filter((file) => file.external).length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      toolRequirements: [...new Set(toolRequirements)],
    },
    content,
    paths,
    directories,
  };
}

export class ProjectPackages {
  private exports = new Map<string, { path: string; result: ProjectPackageResult }>();
  constructor(
    private readonly options: {
      dataRoot: string;
      projectRoot: () => string;
      beforeExport?: () => Promise<void>;
      toolchainRoots?: () => string[];
      privateRoots?: () => string[];
      buildEvidenceState?: () => Promise<BuildEvidenceStatus>;
    },
  ) {}
  async preview() {
    return (
      await collectProjectPackage(this.options.projectRoot(), {
        toolchainRoots: this.options.toolchainRoots?.(),
        privateRoots: this.options.privateRoots?.(),
        buildEvidence: await this.options.buildEvidenceState?.(),
      })
    ).plan;
  }
  async export(options: {
    confirmExternal?: true;
    allowIncomplete?: true;
    expectedProjectRoot?: string;
  }): Promise<ProjectPackageResult> {
    const projectRoot = this.options.projectRoot();
    if (
      options.expectedProjectRoot &&
      path.resolve(options.expectedProjectRoot) !== path.resolve(projectRoot)
    )
      throw new Error('error.projectChanged');
    await this.options.beforeExport?.();
    const scanned = await collectProjectPackage(projectRoot, {
      toolchainRoots: this.options.toolchainRoots?.(),
      privateRoots: this.options.privateRoots?.(),
      buildEvidence: await this.options.buildEvidenceState?.(),
    });
    if (this.options.projectRoot() !== projectRoot) throw new Error('error.projectChanged');
    if (scanned.plan.externalCount && !options.confirmExternal)
      throw new Error('error.packageConfirmExternal');
    if (scanned.plan.warnings.length && !options.allowIncomplete) throw new Error('error.packageUnresolved');
    const id = randomUUID();
    const directory = path.join(this.options.dataRoot, 'exports');
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, id + '.zip');
    const prefix = scanned.plan.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'project';
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      portable: scanned.plan.warnings.length === 0,
      toolRequirements: scanned.plan.toolRequirements,
      files: scanned.plan.files.map((file) => ({
        path: file.destination,
        external: file.external,
        size: file.size,
        sha256: hash(scanned.content.get(file.source)!),
      })),
      warnings: scanned.plan.warnings.map((warning) => ({
        ...warning,
        reference: path.isAbsolute(warning.reference) ? path.basename(warning.reference) : warning.reference,
      })),
    };
    async function* entries(): AsyncGenerator<ZipEntry> {
      for (const file of scanned.plan.files)
        yield { path: prefix + '/' + file.destination, data: scanned.content.get(file.source)! };
      yield {
        path: prefix + '/.blode-share/manifest.json',
        data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
      };
      yield {
        path: prefix + '/.blode-share/README.md',
        data: Buffer.from(
          '# Shared Blode project\n\nOpen this folder in Blode Studio. External project dependencies were copied into dependencies/ and supported build paths rewritten in this copy. Install/select toolRequirements from .blode-share/manifest.json. Check portable and warnings before building. Native compiler binaries and credentials are not included.\n',
        ),
      };
    }
    let size: number;
    try {
      size = await writeZip(target, entries());
    } catch (error) {
      await fs.unlink(target).catch(() => {});
      throw error;
    }
    const result = { id, name: prefix + '.zip', size, warnings: scanned.plan.warnings };
    this.exports.set(id, { path: target, result });
    while (this.exports.size > 4) {
      const oldest = this.exports.keys().next().value!;
      const file = this.exports.get(oldest)!;
      this.exports.delete(oldest);
      await fs.unlink(file.path).catch(() => {});
    }
    return structuredClone(result);
  }
  file(id: string) {
    const entry = this.exports.get(id);
    if (!entry) throw new Error('error.packageExpired');
    return entry;
  }
  download(id: string) {
    const entry = this.file(id);
    return { path: entry.path, name: entry.result.name };
  }
}
