import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { parseRuntimePluginManifest } from '../src/core/runtime-plugin-schema';
import { writeZip, type ZipEntry } from '../src/core/zip';
import type { RuntimePluginManifest } from '../src/shared/plugins';

const repository = fileURLToPath(new URL('..', import.meta.url));
const factories: Record<
  string,
  { factory: string; tools: NonNullable<RuntimePluginManifest['compiler']['managedTools']> }
> = {
  Esp32_S3_CAM: {
    factory: 'createEsp32S3Runtime',
    tools: [
      { id: 'arduino-cli', name: 'Arduino CLI' },
      { id: 'arduino-esp32', name: 'Arduino ESP32 core' },
      { id: 'esptool', name: 'Python / esptool' },
    ],
  },
  STM32F103C8T6: {
    factory: 'createStm32Runtime',
    tools: [
      { id: 'gnu-arm', name: 'GNU Arm Embedded GCC' },
      { id: 'stlink', name: 'stlink-tools' },
    ],
  },
};
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};
const forbidden = new Set(['node_modules', '.git', '.tools', '.blode', '.uel', '.env']);
const safeRelative = (value: string) =>
  !!value &&
  !path.isAbsolute(value) &&
  !path.win32.isAbsolute(value) &&
  !value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') &&
  !/[\0\r\n:]/.test(value);

/** Matches RUNTIME_VIEW_CSP: inline scripts/styles and data image URLs, no asset server. */
function validateViewAssets(html: string, file: string) {
  const sourceAttribute = /\b(?:src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const tag of html.match(/<(?:script|link|img|source|video|audio|iframe|embed|object)\b[^>]*>/gi) ??
    []) {
    for (const match of tag.matchAll(sourceAttribute)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (/^<img\b/i.test(tag) && !/^srcset\b/i.test(match[0]) && /^data:/i.test(value)) continue;
      throw new Error(
        `Unsupported external view asset in ${file}: use inline JavaScript/CSS and data URLs for images.`,
      );
    }
  }
  if (/@import\b/i.test(html) || /url\(\s*['"]?(?!data:|#)[^)'"\s]/i.test(html))
    throw new Error(`Unsupported CSS asset in ${file}: use inline styles and data URLs.`);
}

async function* resources(
  root: string,
  directory = root,
): AsyncGenerator<{ relative: string; source: string }> {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    if (forbidden.has(entry.name) || entry.name.startsWith('.')) continue;
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime packages cannot contain symbolic links: ${source}`);
    if (entry.isDirectory()) {
      yield* resources(root, source);
      continue;
    }
    if (!entry.isFile() || /\.(?:tsx?|map)$/i.test(entry.name)) continue;
    const relative = path.relative(root, source).replaceAll('\\', '/');
    if (
      relative === 'manifest.json' ||
      relative === 'package.json' ||
      relative === 'package-lock.json' ||
      relative === 'package-manifest.json'
    )
      continue;
    yield { relative, source };
  }
}

/** All generated runtime calls use the public host argument; no host source import survives. */
function wrapper(sourceFile: string, factory: string, sourceId: string, acceptsManifest: boolean): string {
  return `import { ${factory} as createSourceRuntime } from ${JSON.stringify(sourceFile)};
export async function createRuntime(host, manifest) {
  const sourceId = ${JSON.stringify(sourceId)};
  const runtime = await createSourceRuntime(host${acceptsManifest ? ', { ...manifest, id: sourceId, defaultConfig: { ...manifest.defaultConfig, boardId: sourceId } }' : ''});
  const configIn = (config) => ({ ...config, boardId: sourceId });
  const configOut = (config) => config ? ({ ...config, boardId: manifest.id }) : config;
  const inputsIn = (inputs) => {
    const platform = inputs.settings?.platforms?.[manifest.id];
    return platform ? { ...inputs, settings: { ...inputs.settings, platforms: { ...inputs.settings.platforms, [sourceId]: platform } } } : inputs;
  };
  return {
    id: manifest.id, transport: manifest.transport, sourceInputs: runtime.sourceInputs ?? [],
    status: (config, refresh) => runtime.status(configIn(config), refresh),
    install: (config) => runtime.install(configIn(config)),
    async discover(config) { return (await runtime.discover(configIn(config))).map((candidate) => ({ ...candidate, id: manifest.id + ':' + candidate.id, platformId: manifest.id })); },
    async probe(config, selection) { const result = await runtime.probe(configIn(config), selection); return { ...result, config: configOut(result.config) }; },
    build: (config, inputs) => runtime.build(configIn(config), inputsIn(inputs)),
    flash: (config, result) => runtime.flash(configIn(config), result),
    ...(runtime.flashPrepared ? { flashPrepared: (config, image) => runtime.flashPrepared(configIn(config), image) } : {}),
    ...(runtime.projectConfig ? { projectConfig: async (config, inputs) => configOut(await runtime.projectConfig(configIn(config), inputsIn(inputs))) } : {}),
    ...(runtime.buildInputs ? { buildInputs: (config, inputs) => runtime.buildInputs(configIn(config), inputsIn(inputs)) } : {}),
    invalidate: () => runtime.invalidate(),
    ...(runtime.dispose ? { dispose: () => runtime.dispose() } : {}),
    ...(runtime.device ? { device: runtime.device } : {}),
    ...(runtime.debugger ? { debugger: runtime.debugger } : {}),
  };
}
`;
}

export interface PackageRuntimeOptions {
  source: string;
  output: string;
  id?: string;
  zip?: boolean;
  factory?: string;
}

export async function packageRuntime(options: PackageRuntimeOptions) {
  const source = await fs.realpath(path.resolve(options.source));
  if (
    !(await fs.lstat(path.resolve(options.source))).isDirectory() ||
    (await fs.lstat(path.resolve(options.source))).isSymbolicLink()
  )
    throw new Error('Source must be a real module directory.');
  const manifestFile = path.join(source, 'manifest.json');
  const manifestInfo = await fs.lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 256000)
    throw new Error('Invalid source manifest.');
  const raw = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (!safeRelative(raw.runtime)) throw new Error('The source runtime must be inside its module directory.');
  const sourceFile = path.resolve(source, raw.runtime);
  if (!inside(source, await fs.realpath(sourceFile)) || (await fs.lstat(sourceFile)).isSymbolicLink())
    throw new Error('The runtime entry cannot escape its module directory.');
  const builtin = Object.hasOwn(factories, raw.id) ? factories[raw.id] : undefined;
  const id = options.id ?? (builtin ? `${raw.id}_Module` : raw.id);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid module ID.');
  if (builtin && id === raw.id)
    throw new Error('An external package needs its own ID; built-in IDs cannot be replaced.');
  const factory = options.factory ?? builtin?.factory ?? 'createRuntime';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(factory)) throw new Error('Invalid factory export.');
  const manifestData = {
    ...raw,
    id,
    runtime: 'runtime/index.mjs',
    defaultConfig: { ...raw.defaultConfig, boardId: id },
  };
  delete manifestData.entry;
  if (builtin && raw.compiler?.mode === 'host' && !raw.compiler.forceComponent)
    manifestData.compiler = { mode: 'runtime', baseRuntime: raw.id, managedTools: builtin.tools };
  const manifest = parseRuntimePluginManifest(manifestData);
  const outputRoot = path.resolve(options.output);
  if (inside(source, outputRoot)) throw new Error('Output must be outside the source module.');
  await fs.mkdir(outputRoot, { recursive: true });
  const output = path.join(await fs.realpath(outputRoot), id);
  if (inside(source, output)) throw new Error('Output must be outside the source module.');
  if (await fs.lstat(output).catch(() => null)) throw new Error(`Output already exists: ${output}`);
  const archive = `${output}.zip`;
  if (options.zip && (await fs.lstat(archive).catch(() => null)))
    throw new Error(`Output already exists: ${archive}`);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'blode-runtime-package-'));
  const payload = path.join(staging, id);
  await fs.mkdir(path.join(payload, 'runtime'), { recursive: true });
  try {
    let total = 0;
    const names = new Set<string>();
    for await (const item of resources(source)) {
      if (item.relative === manifest.runtime) continue;
      if (names.has(item.relative.toLowerCase()))
        throw new Error(`Case-colliding resource: ${item.relative}`);
      names.add(item.relative.toLowerCase());
      const size = (await fs.stat(item.source)).size;
      total += size;
      if (total > 500_000_000 || size > 100_000_000 || names.size > 9000)
        throw new Error('Runtime resources exceed package limits.');
      const destination = path.join(payload, item.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(item.source, destination);
    }
    const result = await build({
      stdin: {
        contents: wrapper(sourceFile, factory, raw.id, builtin?.factory !== factory),
        resolveDir: source,
        sourcefile: 'runtime-package-entry.ts',
        loader: 'ts',
      },
      outfile: path.join(payload, manifest.runtime),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      logLevel: 'silent',
      sourcemap: false,
      metafile: true,
      plugins: [
        {
          name: 'no-private-host-implementation',
          setup(builder) {
            builder.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async (args) => {
              const actualFile = await fs.realpath(args.path);
              if (inside(path.join(repository, 'src', 'core'), actualFile))
                throw new Error(
                  'Runtime modules must use the public host SDK instead of importing src/core.',
                );
              if (
                inside(path.join(repository, 'extensions', 'boards'), actualFile) &&
                !inside(source, actualFile)
              )
                throw new Error('Runtime modules cannot import another board implementation.');
              let contents = await fs.readFile(args.path, 'utf8');
              const urls = [
                ...contents.matchAll(/new\s+URL\(\s*(['"])([^'"\\\r\n]*)\1\s*,\s*import\.meta\.url\s*\)/g),
              ];
              for (const match of urls.reverse()) {
                const assetUrl = new URL(match[2], pathToFileURL(args.path));
                if (assetUrl.protocol !== 'file:')
                  throw new Error('Use host.pluginRoot for runtime resource paths.');
                const asset = fileURLToPath(assetUrl);
                if (!inside(source, await fs.realpath(asset)))
                  throw new Error('Runtime URL resource escapes its module.');
                const relative = path.relative(source, asset);
                if (!(await fs.stat(path.join(payload, relative)).catch(() => null)))
                  throw new Error(`Runtime URL resource was not packaged: ${relative}`);
                const target = path.posix.relative(
                  path.posix.dirname(manifest.runtime),
                  relative.replaceAll('\\', '/'),
                );
                const replacement = `new URL(${JSON.stringify(target.startsWith('.') ? target : './' + target)}, __BLODE_PACKAGE_URL__)`;
                contents =
                  contents.slice(0, match.index) +
                  replacement +
                  contents.slice(match.index! + match[0].length);
              }
              if (/\bimport\.meta\.url\b/.test(contents))
                throw new Error(
                  'Dynamic import.meta.url resources cannot be relocated; use host.pluginRoot.',
                );
              contents = contents.replaceAll('__BLODE_PACKAGE_URL__', 'import.meta.url');
              const extension = path.extname(args.path).toLowerCase();
              return {
                contents,
                loader:
                  extension === '.tsx'
                    ? 'tsx'
                    : extension === '.jsx'
                      ? 'jsx'
                      : /\.[cm]?ts$/.test(extension)
                        ? 'ts'
                        : 'js',
              };
            });
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) return;
              const resolved = path.resolve(args.resolveDir, args.path);
              if (inside(path.join(repository, 'src', 'core'), resolved))
                return {
                  errors: [
                    { text: 'Runtime modules must use the public host SDK instead of importing src/core.' },
                  ],
                };
              return;
            });
          },
        },
      ],
    });
    for (const entry of Object.values(result.metafile!.outputs))
      for (const dependency of entry.imports)
        if (
          dependency.external &&
          !dependency.path.startsWith('node:') &&
          !builtinModules.includes(dependency.path)
        )
          throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
    await fs.writeFile(path.join(payload, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.writeFile(
      path.join(payload, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n',
    );
    for (const relative of [
      manifest.runtime,
      manifest.compiler.defaultTool?.executable,
      manifest.debugger.view,
      manifest.ui.view,
      ...(manifest.ui.views?.map((view) => view.file) ?? []),
      ...(manifest.languages?.entries.flatMap((entry) => [
        ...entry.catalogs,
        ...Object.values(entry.standards ?? {}).flat(),
      ]) ?? []),
    ].filter((value): value is string => !!value))
      if (!(await fs.stat(path.join(payload, relative)).catch(() => null))?.isFile())
        throw new Error(`Missing declared resource: ${relative}`);
    for (const relative of [
      manifest.debugger.view,
      manifest.ui.view,
      ...(manifest.ui.views?.map((view) => view.file) ?? []),
    ].filter((value): value is string => !!value))
      validateViewAssets(await fs.readFile(path.join(payload, relative), 'utf8'), relative);
    const hashes: { path: string; size: number; sha256: string }[] = [];
    async function* entries(directory = payload): AsyncGenerator<ZipEntry> {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      )) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* entries(full);
        else
          yield {
            path: `${id}/${path.relative(payload, full).replaceAll('\\', '/')}`,
            data: await fs.readFile(full),
            mode: (await fs.stat(full)).mode,
          };
      }
    }
    for await (const entry of entries())
      hashes.push({
        path: entry.path.slice(id.length + 1),
        size: entry.data.length,
        sha256: createHash('sha256').update(entry.data).digest('hex'),
      });
    await fs.writeFile(
      path.join(payload, 'package-manifest.json'),
      JSON.stringify({ id, version: manifest.version, files: hashes }, null, 2) + '\n',
    );
    if (options.zip) await writeZip(archive, entries());
    // The destination is new. Never merge into or clean an existing installation.
    await fs.mkdir(output);
    for (const entry of await fs.readdir(payload))
      await fs.cp(path.join(payload, entry), path.join(output, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    return { directory: output, archive: options.zip ? archive : undefined, manifest };
  } finally {
    if (inside(os.tmpdir(), staging) && path.basename(staging).startsWith('blode-runtime-package-'))
      await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  if (!args[0] || args.includes('--help'))
    process.stdout.write(
      'Usage: npm run package:runtime -- <module-directory> --output <directory> [--id <unique-id>] [--factory <export>] [--zip]\n',
    );
  else {
    const output = option('--output');
    if (!output) throw new Error('--output is required.');
    const result = await packageRuntime({
      source: args[0],
      output,
      id: option('--id'),
      factory: option('--factory'),
      zip: args.includes('--zip'),
    });
    process.stdout.write(result.directory + '\n' + (result.archive ? result.archive + '\n' : ''));
  }
}
