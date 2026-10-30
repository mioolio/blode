import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  ExtensionAppearance,
  ExtensionReview,
  ExtensionValues,
  GeneralExtensionInfo,
  GeneralExtensionsState,
} from '../../shared/general-extensions';
import type { RuntimeViewContribution } from '../../shared/plugins';
import { writeZip } from '../zip';
import {
  readExtensionDirectory,
  readExtensionSource,
  parseExtensionPackage,
  type ExtensionPackage,
} from './package';
import { extensionId, extensionValuesSchema } from './schema';
import { renderExtensionDocument } from './view';

interface Record {
  directory: string;
  package: ExtensionPackage;
  enabled: boolean;
  session?: string;
  instance?: { dispose?(): unknown };
  loaded?: string;
  restartRequired?: boolean;
}
interface Settings {
  enabled: string[];
  values: { [id: string]: ExtensionValues };
}
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const mime = (file: string) =>
  ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  })[path.extname(file).toLowerCase()];
export class GeneralExtensions {
  readonly directory: string;
  private records = new Map<string, Record>();
  private reviews = new Map<string, { source: string; package: ExtensionPackage; expires: number }>();
  private artifacts = new Map<string, { path: string; name: string }>();
  private config: Settings = { enabled: [], values: {} };
  private initialized = false;
  private closed = false;
  private readonly instanceId = randomUUID();
  private revision = 0;
  private queue = Promise.resolve();
  private loaded = new Map<string, string>();
  constructor(
    private readonly options: {
      dataRoot: string;
      examplesRoot?: string;
      changed?: () => void;
      log?: (message: string) => void;
      openView?: (id: string, view: RuntimeViewContribution) => Promise<void>;
      openPanel?: (id: string, view: RuntimeViewContribution) => Promise<void>;
    },
  ) {
    this.directory = path.resolve(options.dataRoot, 'extensions');
  }
  private async locked<T>(action: () => Promise<T>, closing = false): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.closed && !closing) throw new Error('error.operationCancelled');
      return await action();
    } finally {
      release();
    }
  }
  private async initialize() {
    if (this.initialized) return;
    await fs.mkdir(this.directory, { recursive: true });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('error.extensionPath');
    const file = path.join(this.options.dataRoot, 'extensions.json');
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('error.extensionPath');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      this.config = {
        enabled: Array.isArray(saved.enabled)
          ? saved.enabled.filter((id: unknown) => extensionId.safeParse(id).success)
          : [],
        values: {},
      };
      for (const [id, value] of Object.entries(saved.values ?? {}))
        if (extensionId.safeParse(id).success && extensionValuesSchema.safeParse(value).success)
          this.config.values[id] = value as ExtensionValues;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    this.initialized = true;
  }
  private async persist() {
    const file = path.join(this.options.dataRoot, 'extensions.json'),
      temp = file + '.' + randomUUID() + '.tmp';
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isSymbolicLink() || (stat && (!stat.isFile() || stat.nlink > 1)))
      throw new Error('error.extensionPath');
    try {
      await fs.writeFile(temp, JSON.stringify(this.config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  private changed() {
    this.revision++;
    this.options.changed?.();
  }
  private record(id: string) {
    const record = this.records.get(extensionId.parse(id));
    if (!record) throw new Error('error.extensionMissing');
    return record;
  }
  private async signingKey() {
    const file = path.join(this.options.dataRoot, 'extension-trust.key');
    let stat = await fs.lstat(file).catch(() => null);
    if (!stat) {
      try {
        await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = await fs.lstat(file);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size !== 32)
      throw new Error('error.extensionPath');
    return fs.readFile(file);
  }
  private marker(record: Record) {
    return {
      id: record.package.manifest.id,
      directory: record.directory,
      fingerprint: record.package.fingerprint,
      suppressWarning: true,
    };
  }
  private async permanent(record: Record): Promise<boolean> {
    const file = path.join(record.directory, '.uel'),
      stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096) return false;
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8')),
        declaration = this.marker(record);
      if (
        Object.entries(declaration).some(([key, value]) => saved[key] !== value) ||
        !/^[a-f0-9]{64}$/.test(saved.signature)
      )
        return false;
      const signed = createHmac('sha256', await this.signingKey())
        .update(JSON.stringify(declaration))
        .digest();
      return timingSafeEqual(signed, Buffer.from(saved.signature, 'hex'));
    } catch {
      return false;
    }
  }
  private async stop(record: Record) {
    record.enabled = false;
    try {
      await record.instance?.dispose?.();
    } finally {
      record.instance = undefined;
    }
  }
  private async refresh() {
    await this.initialize();
    const errors: GeneralExtensionsState['errors'] = [],
      live = new Set<string>();
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !extensionId.safeParse(entry.name).success)
        continue;
      const directory = path.join(this.directory, entry.name);
      try {
        const pack = parseExtensionPackage(await readExtensionDirectory(directory));
        if (pack.manifest.id !== entry.name) throw new Error('error.extensionManifest');
        let record = this.records.get(entry.name);
        if (!record) {
          record = { directory, package: pack, enabled: false, loaded: this.loaded.get(entry.name) };
          this.records.set(entry.name, record);
        }
        if (record.package.fingerprint !== pack.fingerprint) {
          await this.stop(record);
          record.session = undefined;
        }
        record.package = pack;
        this.values(record);
        record.restartRequired = !!record.loaded && record.loaded !== pack.fingerprint;
        live.add(entry.name);
        const allowed =
          !record.restartRequired && (record.session === pack.fingerprint || (await this.permanent(record)));
        if (!allowed) await this.stop(record);
        else if (this.config.enabled.includes(entry.name) && !record.enabled) await this.activate(record);
      } catch (error) {
        const record = this.records.get(entry.name);
        if (record) await this.stop(record);
        errors.push({
          directory,
          message: error instanceof Error ? error.message : 'error.extensionManifest',
        });
      }
    }
    for (const [id, record] of this.records)
      if (!live.has(id)) {
        await this.stop(record);
        this.records.delete(id);
      }
    return errors;
  }
  private values(record: Record): ExtensionValues {
    const manifest = record.package.manifest;
    let defaults: ExtensionValues = {};
    if (manifest.settings?.defaults) {
      try {
        defaults = extensionValuesSchema.parse(
          JSON.parse(record.package.files.get(manifest.settings.defaults)!.toString('utf8')),
        );
      } catch {
        throw new Error('error.extensionSettings');
      }
    }
    const values = {
      ...Object.fromEntries(
        (manifest.settings?.fields ?? [])
          .filter((field) => field.default !== undefined)
          .map((field) => [field.id, field.default!]),
      ),
      ...defaults,
      ...this.config.values[manifest.id],
    };
    this.validate(record, values);
    return values;
  }
  private validate(record: Record, values: ExtensionValues) {
    for (const [id, value] of Object.entries(values)) {
      const field = record.package.manifest.settings?.fields.find((field) => field.id === id);
      if (
        !field ||
        (field.type === 'boolean' && typeof value !== 'boolean') ||
        (field.type === 'number' &&
          (typeof value !== 'number' ||
            !Number.isFinite(value) ||
            (field.min !== undefined && value < field.min) ||
            (field.max !== undefined && value > field.max))) ||
        (['text', 'select'].includes(field.type) && typeof value !== 'string') ||
        (field.type === 'select' && !field.options?.some((option) => option.value === value))
      )
        throw new Error('error.extensionSettings');
    }
  }
  private async activate(record: Record) {
    if (record.restartRequired) throw new Error('error.extensionRestartRequired');
    if (record.package.manifest.runtime && !record.instance) {
      const entry = path.join(record.directory, record.package.manifest.runtime);
      const loaded = await import(pathToFileURL(entry).href + '?fingerprint=' + record.package.fingerprint);
      if (typeof loaded.activate !== 'function') throw new Error('error.extensionRuntime');
      record.loaded = record.package.fingerprint;
      this.loaded.set(record.package.manifest.id, record.loaded!);
      const dataDirectory = path.join(this.options.dataRoot, 'extension-data', record.package.manifest.id);
      await fs.mkdir(dataDirectory, { recursive: true });
      const instance = await loaded.activate(
        Object.freeze({
          id: record.package.manifest.id,
          directory: record.directory,
          dataDirectory,
          settings: () => structuredClone(this.values(record)),
          log: (message: unknown) => this.options.log?.(String(message).slice(0, 4096)),
        }),
      );
      if (instance && typeof instance !== 'object') throw new Error('error.extensionRuntime');
      record.instance = instance ?? {};
    }
    record.enabled = true;
  }
  private async info(record: Record): Promise<GeneralExtensionInfo> {
    const manifest = record.package.manifest,
      values = this.values(record),
      locales: GeneralExtensionInfo['locales'] = {};
    for (const [locale, file] of Object.entries(manifest.locales ?? {})) {
      const bytes = record.package.files.get(file)!;
      if (bytes.length > 256_000) throw new Error('error.extensionSize');
      try {
        const json = JSON.parse(bytes.toString('utf8'));
        if (
          !json ||
          typeof json !== 'object' ||
          Array.isArray(json) ||
          Object.values(json).some((value) => typeof value !== 'string')
        )
          throw Error();
        locales[locale] = json;
      } catch {
        throw new Error('error.extensionManifest');
      }
    }
    const preset = manifest.ui.presets?.find(
      (preset) => preset.id === values[manifest.ui.presetSetting ?? ''],
    );
    const appearance: ExtensionAppearance = {
      ...manifest.ui.appearance,
      ...preset?.appearance,
      variables: { ...manifest.ui.appearance?.variables, ...preset?.appearance.variables },
      menuOverrides: { ...manifest.ui.appearance?.menuOverrides, ...preset?.appearance.menuOverrides },
    };
    const background = appearance.background && record.package.files.get(appearance.background),
      type = appearance.background && mime(appearance.background);
    return {
      id: manifest.id,
      directory: record.directory,
      fingerprint: record.package.fingerprint,
      enabled: record.enabled,
      trust: (await this.permanent(record))
        ? 'permanent'
        : record.session === record.package.fingerprint
          ? 'session'
          : 'required',
      restartRequired: record.restartRequired,
      manifest: structuredClone(manifest),
      settings: values,
      locales,
      ...(record.enabled
        ? {
            appearance: {
              ...appearance,
              ...(background && type && background.length <= 4_000_000
                ? { backgroundData: `data:${type};base64,${background.toString('base64')}` }
                : {}),
            },
          }
        : {}),
    };
  }
  private async snapshot(errors: GeneralExtensionsState['errors'] = []): Promise<GeneralExtensionsState> {
    const examples: GeneralExtensionsState['examples'] = [];
    if (this.options.examplesRoot)
      for (const entry of await fs
        .readdir(this.options.examplesRoot, { withFileTypes: true })
        .catch(() => [])) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(this.options.examplesRoot, entry.name);
        try {
          const pack = await readExtensionSource(directory);
          examples.push({ id: pack.manifest.id, name: pack.manifest.name, path: directory });
        } catch {
          /* Unrelated source folders are not installable examples. */
        }
      }
    return {
      revision: this.revision,
      instanceId: this.instanceId,
      directory: this.directory,
      plugins: await Promise.all([...this.records.values()].map((record) => this.info(record))),
      errors,
      examples,
    };
  }
  state() {
    return this.locked(async () => this.snapshot(await this.refresh()));
  }
  review(request: { path: string }): Promise<ExtensionReview> {
    return this.locked(async () => {
      await this.initialize();
      const pack = await readExtensionSource(request.path),
        ticket = randomUUID();
      for (const [id, review] of this.reviews) if (review.expires < Date.now()) this.reviews.delete(id);
      if (this.reviews.size >= 16) throw new Error('rpc.limitExceeded');
      this.reviews.set(ticket, { source: request.path, package: pack, expires: Date.now() + 15 * 60_000 });
      return {
        ticket,
        fingerprint: pack.fingerprint,
        manifest: pack.manifest,
        files: [...pack.files.keys()],
        bytes: pack.bytes,
      };
    });
  }
  install(request: { ticket: string; fingerprint: string; confirm: true }) {
    return this.locked(async () => {
      if (request.confirm !== true) throw new Error('error.extensionConfirm');
      await this.initialize();
      const review = this.reviews.get(request.ticket);
      if (!review || review.expires <= Date.now()) throw new Error('error.extensionReviewExpired');
      const pack = await readExtensionSource(review.source);
      if (pack.fingerprint !== request.fingerprint || pack.fingerprint !== review.package.fingerprint)
        throw new Error('error.extensionChanged');
      const target = path.join(this.directory, pack.manifest.id);
      if (await fs.lstat(target).catch(() => null)) throw new Error('error.extensionDuplicate');
      const stage = await fs.mkdtemp(path.join(this.directory, '.install-'));
      try {
        for (const [relative, bytes] of pack.files) {
          const file = path.resolve(stage, relative);
          if (!inside(stage, file)) throw new Error('error.extensionPath');
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, bytes, { flag: 'wx' });
        }
        const copied = parseExtensionPackage(await readExtensionDirectory(stage));
        if (copied.fingerprint !== pack.fingerprint) throw new Error('error.extensionChanged');
        await fs.rename(stage, target);
      } finally {
        if (inside(this.directory, stage)) await fs.rm(stage, { recursive: true, force: true });
      }
      this.reviews.delete(request.ticket);
      this.changed();
      return this.snapshot(await this.refresh());
    });
  }
  enable(request: { id: string; fingerprint: string; confirm: true; permanent: boolean }) {
    return this.locked(async () => {
      if (request.confirm !== true) throw new Error('error.extensionConfirm');
      await this.refresh();
      const record = this.record(request.id);
      if (request.fingerprint !== record.package.fingerprint) throw new Error('error.extensionChanged');
      if (record.restartRequired) throw new Error('error.extensionRestartRequired');
      if (request.permanent) {
        record.session = undefined;
        const declaration = this.marker(record),
          signature = createHmac('sha256', await this.signingKey())
            .update(JSON.stringify(declaration))
            .digest('hex');
        const file = path.join(record.directory, '.uel'),
          stat = await fs.lstat(file).catch(() => null);
        if (stat?.isSymbolicLink() || (stat && (!stat.isFile() || stat.nlink > 1)))
          throw new Error('error.extensionPath');
        await fs.writeFile(file, JSON.stringify({ ...declaration, signature }, null, 2) + '\n', {
          mode: 0o600,
        });
      } else record.session = record.package.fingerprint;
      try {
        await this.activate(record);
      } catch (error) {
        await this.stop(record);
        throw error;
      }
      this.config.enabled = [...new Set([...this.config.enabled, request.id])];
      await this.persist();
      this.changed();
      return this.snapshot();
    });
  }
  disable(request: { id: string }) {
    return this.locked(async () => {
      await this.refresh();
      await this.stop(this.record(request.id));
      this.config.enabled = this.config.enabled.filter((id) => id !== request.id);
      await this.persist();
      this.changed();
      return this.snapshot();
    });
  }
  remove(request: { id: string; confirm: true }) {
    return this.locked(async () => {
      if (request.confirm !== true) throw new Error('error.extensionConfirm');
      await this.refresh();
      const record = this.record(request.id);
      await this.stop(record);
      const actual = await fs.realpath(record.directory);
      if (
        !inside(this.directory, actual) ||
        actual !== path.resolve(this.directory, request.id) ||
        (await fs.lstat(record.directory)).isSymbolicLink()
      )
        throw new Error('error.extensionPath');
      await fs.rm(actual, { recursive: true });
      this.records.delete(request.id);
      this.config.enabled = this.config.enabled.filter((id) => id !== request.id);
      delete this.config.values[request.id];
      await this.persist();
      this.changed();
      return this.snapshot();
    });
  }
  configure(request: { id: string; values: ExtensionValues }) {
    return this.locked(async () => {
      await this.refresh();
      const record = this.record(request.id);
      if (!record.enabled || !record.package.manifest.permissions.includes('settings'))
        throw new Error('error.extensionPermission');
      const values = { ...this.values(record), ...extensionValuesSchema.parse(request.values) };
      this.validate(record, values);
      this.config.values[request.id] = values;
      await this.persist();
      this.changed();
      return this.snapshot();
    });
  }
  context(request: { id: string }) {
    return this.locked(async () => {
      await this.refresh();
      const record = this.record(request.id);
      if (!record.enabled) throw new Error('error.extensionDisabled');
      return this.info(record);
    });
  }
  viewDocument(request: { id: string; view: string }) {
    return this.locked(async () => {
      await this.refresh();
      const record = this.record(request.id);
      if (!record.enabled) throw new Error('error.extensionDisabled');
      const view = record.package.manifest.ui.views?.find((view) => view.id === request.view);
      if (!view) throw new Error('error.extensionPermission');
      return renderExtensionDocument(record.package, view);
    });
  }
  openView(request: { id: string; view: string }) {
    return this.locked(async () => {
      await this.refresh();
      const record = this.record(request.id),
        view = record.package.manifest.ui.views?.find((view) => view.id === request.view);
      if (!record.enabled || !view) throw new Error('error.extensionPermission');
      if (view.location === 'panel') {
        await this.options.openPanel?.(request.id, view);
        return { destination: 'panel' as const };
      }
      if (this.options.openView) {
        await this.options.openView(request.id, view);
        return { destination: 'window' as const };
      }
      return {
        destination: 'browser' as const,
        url: `/#/extension-view/${encodeURIComponent(request.id)}/${encodeURIComponent(view.id)}`,
      };
    });
  }
  export(request: { id: string; confirm: true }) {
    return this.locked(async () => {
      if (request.confirm !== true) throw new Error('error.extensionConfirm');
      await this.refresh();
      const record = this.record(request.id),
        id = randomUUID(),
        directory = path.join(this.options.dataRoot, 'exports');
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, id + '.zip');
      await writeZip(
        file,
        (async function* () {
          for (const [name, data] of record.package.files) yield { path: name, data };
        })(),
      );
      const name = `${record.package.manifest.id}-${record.package.manifest.version}.zip`;
      this.artifacts.set(id, { path: file, name });
      return { id, name, size: (await fs.stat(file)).size };
    });
  }
  download(id: string) {
    const file = this.artifacts.get(id);
    if (!file) throw new Error('error.packageExpired');
    return file;
  }
  async close() {
    await this.locked(async () => {
      this.closed = true;
      await Promise.allSettled([...this.records.values()].map((record) => this.stop(record)));
      this.records.clear();
    }, true);
  }
}
