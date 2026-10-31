import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeZip, type FileZipEntry, type ZipEntry } from './zip';
import { runCommand } from './process';

export interface ArchiveOptions {
  signal?: AbortSignal;
  maxEntries?: number;
  maxBytes?: number;
  onProgress?: (percent: number) => void;
  entryCount?: number;
  onStage?: (processedFiles: number, totalFiles: number) => void;
  onLine?: (message: string) => void;
}
export interface ArchiveWriter {
  write(
    file: string,
    entries: AsyncIterable<FileZipEntry | ZipEntry>,
    options?: ArchiveOptions,
  ): Promise<number>;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Pinned 7-Zip console with a platform-independent fallback. No shell is involved. */
export class BundledArchiveWriter implements ArchiveWriter {
  constructor(private readonly options: { root: string; dataRoot: string; runner?: typeof runCommand }) {}
  private async command() {
    const manifest = JSON.parse(await fs.readFile(path.join(this.options.root, 'manifest.json'), 'utf8'));
    const target = `${process.platform}-${process.arch}`;
    const entry = manifest.platforms?.[target];
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[\d.]+$/.test(manifest.version))
      throw new Error('7-Zip runtime unavailable');
    const source = path.resolve(this.options.root, entry.file);
    if (!inside(path.resolve(this.options.root), source) || (await fs.lstat(source)).isSymbolicLink())
      throw new Error('Invalid archive runtime');
    const bytes = await fs.readFile(source);
    if (hash(bytes) !== entry.sha256) throw new Error('Archive runtime checksum mismatch');
    const cache = path.join(this.options.dataRoot, 'builtin-archives', manifest.version, target);
    await fs.mkdir(cache, { recursive: true });
    if (!inside(await fs.realpath(this.options.dataRoot), await fs.realpath(cache)))
      throw new Error('Invalid archive cache');
    const file = path.join(cache, path.basename(entry.file));
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isSymbolicLink() || (stat && (!stat.isFile() || stat.nlink > 1)))
      throw new Error('Invalid archive cache');
    if (!stat || hash(await fs.readFile(file)) !== entry.sha256)
      await fs.writeFile(file, bytes, { mode: 0o755 });
    return { file, version: manifest.version as string };
  }
  async write(
    file: string,
    entries: AsyncIterable<FileZipEntry | ZipEntry>,
    options: ArchiveOptions = {},
  ): Promise<number> {
    file = path.resolve(file);
    if (await fs.lstat(file).catch(() => null)) throw new Error('error.packageChanged');
    const parent = path.dirname(file);
    await fs.mkdir(parent, { recursive: true });
    const stage = await fs.mkdtemp(path.join(parent, '.archive-'));
    const saved: (FileZipEntry | ZipEntry)[] = [];
    const names = new Set<string>();
    let bytes = 0;
    let completed = false;
    let lastStage = 0;
    try {
      for await (const entry of entries) {
        options.signal?.throwIfAborted();
        if (
          !entry.path ||
          /[\\:\0\r\n]/.test(entry.path) ||
          entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
          names.has(entry.path.toLowerCase())
        )
          throw new Error('error.packagePathCollision');
        names.add(entry.path.toLowerCase());
        if (saved.length >= (options.maxEntries ?? 10000)) throw new Error('error.packageTooLarge');
        const size = Buffer.isBuffer(entry.data) ? entry.data.length : (await fs.stat(entry.data.file)).size;
        if ((bytes += size) > (options.maxBytes ?? 2_000_000_000)) throw new Error('error.packageTooLarge');
        const destination = path.join(stage, entry.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (Buffer.isBuffer(entry.data))
          await fs.writeFile(destination, entry.data, { flag: 'wx', mode: entry.mode });
        else
          await fs
            .link(entry.data.file, destination)
            .catch(() =>
              fs.copyFile((entry.data as { file: string }).file, destination, constants.COPYFILE_FICLONE),
            );
        saved.push(entry);
        if (options.entryCount && (Date.now() - lastStage > 150 || saved.length === options.entryCount)) {
          options.onStage?.(saved.length, options.entryCount);
          lastStage = Date.now();
        }
      }
      options.signal?.throwIfAborted();
      try {
        const command = await this.command();
        options.onLine?.(`status.archiveEngine: 7-Zip ${command.version} · ZIP/Deflate`);
        const list = path.join(parent, path.basename(stage) + '.txt');
        await fs.writeFile(list, saved.map((entry) => entry.path).join('\n') + '\n', { flag: 'wx' });
        try {
          options.onProgress?.(0);
          const result = await (this.options.runner ?? runCommand)(
            command.file,
            [
              'a',
              '-tzip',
              '-mcu=on',
              '-mx=5',
              '-mmt=2',
              '-bsp1',
              '-bso0',
              '-bse2',
              '-sccUTF-8',
              '-scsUTF-8',
              '-spd',
              '-y',
              file,
              '@' + list,
            ],
            {
              cwd: stage,
              signal: options.signal,
              timeout: 900000,
              encoding: 'utf8',
              onLine: (line) => {
                const match = line.match(/(?:^|\s)(\d{1,3})%/);
                if (match) options.onProgress?.(Math.min(100, Number(match[1])));
              },
            },
          );
          if (result.code !== 0) throw new Error(result.output);
          const size = (await fs.stat(file)).size;
          if (size > (options.maxBytes ?? 2_000_000_000)) throw new Error('error.packageTooLarge');
          options.onProgress?.(100);
          completed = true;
          return size;
        } finally {
          await fs.unlink(list).catch(() => {});
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        await fs.unlink(file).catch(() => {});
        options.onLine?.(
          `status.archivePrimaryFailed: ${(error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f]/g, ' ').slice(0, 1200)}`,
        );
        options.onLine?.('status.archiveFallback');
        options.onProgress?.(0);
        const size = await writeZip(
          file,
          (async function* () {
            for (let i = 0; i < saved.length; i++) {
              yield saved[i];
              options.onProgress?.(((i + 1) / saved.length) * 100);
            }
          })(),
          options,
        );
        completed = true;
        return size;
      }
    } finally {
      if (!completed) await fs.unlink(file).catch(() => {});
      if (inside(parent, stage) && path.basename(stage).startsWith('.archive-'))
        await fs.rm(stage, { recursive: true, force: true });
    }
  }
}
