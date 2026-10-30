import { promises as fs, constants, type ReadStream, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { workspaceAssetRequestSchema } from './workspace-asset-schema';
export { workspaceAssetRequestSchema } from './workspace-asset-schema';
import { safeWorkspacePath } from './workspace';
import {
  assetKind,
  assetMime,
  type WorkspaceAssetPreview,
  type WorkspaceAssetRequest,
} from '../shared/assets';

const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
};
interface Ticket {
  root: string;
  generation: number;
  relative: string;
  signature: string;
}
const signature = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

/** One byte range, including suffix/open ranges used by native media players. */
export function assetByteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) throw new Error('range');
  const first = Number(match[1]),
    last = Number(match[2]);
  let start: number, end: number;
  if (!match[1]) {
    if (!Number.isSafeInteger(last) || last <= 0) throw new Error('range');
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = first;
    end = match[2] ? Math.min(last, size - 1) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      (match[2] && !Number.isSafeInteger(last)) ||
      start >= size ||
      end < start
    )
      throw new Error('range');
  }
  return { start, end };
}

/** Media URLs grant read access to one file in one open-project generation. */
export class WorkspaceAssets {
  private generation = 0;
  private readonly tickets = new Map<string, Ticket>();
  private readonly streams = new Set<ReadStream>();
  constructor(private readonly projectRoot: () => string) {}
  reset() {
    this.generation++;
    this.tickets.clear();
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }
  private async open(root: string, relative: string): Promise<FileHandle> {
    const file = await safeWorkspacePath(root, relative);
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
    try {
      await safeWorkspacePath(root, relative);
      const real = await fs.realpath(file);
      const inside = path.relative(root, real);
      if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('error.invalidPath');
      const [opened, current] = await Promise.all([handle.stat(), fs.stat(real)]);
      if (!opened.isFile() || signature(opened) !== signature(current))
        throw new Error('error.assetUnavailable');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private current(ticket: Ticket) {
    return ticket.generation === this.generation && ticket.root === this.projectRoot();
  }
  async preview(value: WorkspaceAssetRequest): Promise<WorkspaceAssetPreview> {
    const parsed = workspaceAssetRequestSchema.safeParse(value);
    if (!parsed.success) throw new Error('rpc.invalidParams');
    const request = parsed.data,
      root = this.projectRoot(),
      generation = this.generation;
    if (!root || root !== request.expectedProjectRoot) throw new Error('error.assetProjectChanged');
    const handle = await this.open(root, request.path).catch((error) => {
      if (error instanceof Error && error.message.startsWith('error.')) throw error;
      throw new Error('error.assetUnavailable');
    });
    try {
      const stat = await handle.stat();
      const ticket: Ticket = { root, generation, relative: request.path, signature: signature(stat) };
      if (!this.current(ticket)) throw new Error('error.assetProjectChanged');
      const kind = assetKind(request.path);
      let hex: string | undefined;
      if (kind === 'binary') {
        const prefix = Buffer.alloc(Math.min(stat.size, 4096));
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        hex = prefix.subarray(0, bytesRead).toString('hex');
      }
      if (!this.current(ticket)) throw new Error('error.assetProjectChanged');
      // Reuse unchanged descriptors while bounding history independently of file size.
      let id = [...this.tickets].find(
        ([, old]) =>
          old.relative === ticket.relative && old.signature === ticket.signature && this.current(old),
      )?.[0];
      if (!id) {
        if (this.tickets.size >= 1024) this.tickets.delete(this.tickets.keys().next().value!);
        id = randomBytes(32).toString('hex');
        this.tickets.set(id, ticket);
      }
      return {
        path: request.path,
        kind,
        mime: assetMime(request.path),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        url: '/workspace/assets/' + id,
        ...(hex !== undefined ? { hex, truncated: stat.size > 4096 } : {}),
      };
    } finally {
      await handle.close();
    }
  }
  async response(id: string, range: string | null = null, head = false): Promise<Response> {
    const ticket = /^[a-f0-9]{64}$/.test(id) ? this.tickets.get(id) : undefined;
    if (!ticket || !this.current(ticket)) return new Response(null, { status: 404, headers });
    let handle: FileHandle | undefined;
    try {
      handle = await this.open(ticket.root, ticket.relative);
      const stat = await handle.stat();
      if (!this.current(ticket)) {
        await handle.close();
        return new Response(null, { status: 404, headers });
      }
      if (signature(stat) !== ticket.signature) {
        await handle.close();
        return new Response(null, { status: 409, headers });
      }
      let selected: ReturnType<typeof assetByteRange>;
      try {
        selected = assetByteRange(range, stat.size);
      } catch {
        await handle.close();
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'content-range': `bytes */${stat.size}`, 'accept-ranges': 'bytes' },
        });
      }
      const length = selected ? selected.end - selected.start + 1 : stat.size;
      const responseHeaders: Record<string, string> = {
        ...headers,
        'content-type': assetMime(ticket.relative),
        'content-length': String(length),
        'accept-ranges': 'bytes',
      };
      if (selected) responseHeaders['content-range'] = `bytes ${selected.start}-${selected.end}/${stat.size}`;
      if (assetKind(ticket.relative) === 'binary') responseHeaders['content-disposition'] = 'attachment';
      if (head || length === 0) {
        await handle.close();
        return new Response(null, { status: selected ? 206 : 200, headers: responseHeaders });
      }
      const stream = handle.createReadStream({ ...selected, autoClose: true });
      this.streams.add(stream);
      stream.once('close', () => this.streams.delete(stream));
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: selected ? 206 : 200,
        headers: responseHeaders,
      });
    } catch {
      await handle?.close().catch(() => {});
      return new Response(null, { status: 404, headers });
    }
  }
}
