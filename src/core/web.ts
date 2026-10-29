import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CoreApi, LogEvent, ProjectConfig, SerialOptions } from '../shared/contracts';
import { COLLABORATION_CHANNEL, UI_COMMAND_CHANNEL } from '../shared/contracts';
import type { CollaborationEvent } from '../shared/collaboration';
import type { UiRequest } from '../shared/workbench';
import { RecentLogs } from './recent-logs';
import { RUNTIME_VIEW_CSP, renderRuntimeView } from '../shared/runtime-view';

const defaultPort = 47821;
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface WebServerOptions {
  /** Tests may request an ephemeral port without interfering with a running desktop service. */
  port?: number;
  api: CoreApi;
  assistance?: { invoke(method: string, args: unknown[]): Promise<unknown> };
  hostServices?: { invoke(method: string, args: unknown[]): Promise<unknown> };
  packageDownload?: (
    id: string,
  ) => { path: string; name: string } | undefined | Promise<{ path: string; name: string } | undefined>;
  /** Headless browser mode also authenticates requests coming from loopback. */
  requireToken?: boolean;
  debugger?: {
    invoke(method: string, args: unknown[]): Promise<unknown>;
    symbols(bytes: Buffer, name: string): Promise<string>;
  };
  dataRoot: string;
  appRoot: string;
  isPackaged: boolean;
  rendererUrl?: string;
  allowExternal: boolean;
}

export interface WebServerHandle {
  endpoint: string;
  tokenFile: string;
  allowExternal: boolean;
  publish(event: LogEvent): void;
  publishDrafts(drafts: Record<string, string>): void;
  publishCollaboration(event: CollaborationEvent): void;
  publishUiCommand(request: UiRequest): void;
  close(): Promise<void>;
}

const isLoopback = (address?: string) =>
  !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** Accept literal local-service authorities, never arbitrary names resolved by DNS. */
function validHost(authority: string | undefined): boolean {
  if (!authority) return false;
  const match = /^(\[[0-9a-f:.]+\]|[^:\s/\\@?#]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!match || (match[2] && Number(match[2]) > 65535)) return false;
  const hostname = match[1].startsWith('[') ? match[1].slice(1, -1) : match[1];
  return hostname.toLowerCase() === 'localhost' || isIP(hostname) !== 0;
}

const hostMethods = new Set([
  'listRecentProjects',
  'openRecentProject',
  'removeRecentProject',
  'closeProject',
  'firmwareChoosePath',
  'firmwareExportPath',
  'firmwareFlash',
]);
const isHostMethod = (method: string) =>
  /^(?:git|toolVersion|host|projectPackage|terminal|language|runtimePlugin)/.test(method) ||
  hostMethods.has(method);

function lanEndpoint(port: number): string {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === 'IPv4' && !entry.internal) return `http://${entry.address}:${port}`;
  return `http://127.0.0.1:${port}`;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 2_000_000) throw new Error('rpc.limitExceeded');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function invoke(api: CoreApi, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'getState':
      return api.getState();
    case 'listPorts':
      return api.listPorts();
    case 'listDebugProbes':
      return api.listDebugProbes();
    case 'scanDevices':
      return api.scanDevices();
    case 'saveFile':
      return api.saveFile(String(args[0]), String(args[1]));
    case 'createFile':
      return api.createFile(String(args[0]));
    case 'createDirectory':
      return api.createDirectory(String(args[0]));
    case 'renameEntry':
      return api.renameEntry(String(args[0]), String(args[1]));
    case 'deleteEntry':
      return api.deleteEntry(String(args[0]));
    case 'saveConfig':
      return api.saveConfig(args[0] as Awaited<ReturnType<CoreApi['getState']>>['config']);
    case 'setBuildEntry':
      if (args.length !== 1 || typeof args[0] !== 'string' || !args[0] || args[0].length > 1024)
        throw new Error('rpc.invalidParams');
      return api.setBuildEntry(args[0]);
    case 'build':
      return api.build();
    case 'flash':
      return api.flash();
    case 'probe':
      return api.probe(
        typeof args[0] === 'string' ? args[0] : undefined,
        args[1] && typeof args[1] === 'object' ? (args[1] as ProjectConfig) : undefined,
      );
    case 'installToolchain':
      return api.installToolchain();
    case 'serialOpen':
      return api.serialOpen(
        typeof args[0] === 'string' ? args[0] : undefined,
        typeof args[1] === 'number' ? args[1] : undefined,
        args[2] as SerialOptions | undefined,
      );
    case 'serialClose':
      return api.serialClose();
    case 'serialWrite':
      if (
        args.length > 2 ||
        typeof args[0] !== 'string' ||
        (args[1] !== undefined && args[1] !== 'utf8' && args[1] !== 'hex')
      )
        throw new Error('rpc.invalidParams');
      return api.serialWrite(args[0], args[1] as 'utf8' | 'hex' | undefined);
    default:
      throw new Error('rpc.methodNotFound');
  }
}

/** Local browser workspace over HTTP + SSE; external binding requires the token. */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const token = randomBytes(24).toString('hex');
  await fs.mkdir(options.dataRoot, { recursive: true });
  const tokenFile = path.join(options.dataRoot, 'web-token.txt');
  await fs.writeFile(tokenFile, token, 'utf8');

  const host = options.allowExternal ? '0.0.0.0' : '127.0.0.1';
  const clients = new Set<ServerResponse>();
  interface BoundPeer {
    peerId: string;
    actorToken: string;
    projectRoot: string;
    session: string;
    sequence?: number;
  }
  interface PageTransport {
    streams: Set<ServerResponse>;
    peers: Map<string, BoundPeer>;
    closed: boolean;
    timer?: ReturnType<typeof setTimeout>;
    retire?: ReturnType<typeof setTimeout>;
  }
  const pages = new Map<string, PageTransport>();
  const runtimeViews = new Map<string, { id: string; kind: 'debugger' | 'device'; expiresAt: number }>();
  let stopped = false;
  const pruneRuntimeViews = () => {
    for (const [ticket, view] of runtimeViews) if (view.expiresAt <= Date.now()) runtimeViews.delete(ticket);
  };
  const clientId = (value: unknown) =>
    typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
  const releasePeers = async (page: PageTransport) => {
    if (page.streams.size) return;
    page.closed = true;
    const peers = [...page.peers.values()];
    page.peers.clear();
    await Promise.allSettled(peers.map((peer) => options.assistance?.invoke('collaborationLeave', [peer])));
  };
  const pageTransport = (id: string) => {
    let page = pages.get(id);
    if (page) return page;
    if (pages.size >= 512) throw new Error('rpc.limitExceeded');
    page = { streams: new Set(), peers: new Map(), closed: false };
    pages.set(id, page);
    return page;
  };
  const scheduleRelease = (id: string, page: PageTransport) => {
    clearTimeout(page.timer);
    page.timer = setTimeout(() => {
      void releasePeers(page);
      page.retire = setTimeout(() => {
        if (!page.streams.size && pages.get(id) === page) pages.delete(id);
      }, 60_000);
      page.retire.unref();
    }, 200);
    page.timer.unref();
  };
  const recentLogs = new RecentLogs();
  let latestDrafts: Record<string, string> = {};
  const staticRoot = path.join(options.appRoot, 'dist', 'renderer');

  const allowedOrigin = (origin?: string) => {
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      return (
        ['http:', 'https:'].includes(parsed.protocol) &&
        parsed.origin === origin &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
      );
    } catch {
      return false;
    }
  };
  const validOrigin = (request: IncomingMessage, url: URL) =>
    !request.headers.origin || request.headers.origin === url.origin || allowedOrigin(request.headers.origin);

  const cors = (request: IncomingMessage, response: ServerResponse) => {
    const origin = request.headers.origin;
    if (allowedOrigin(origin)) response.setHeader('Access-Control-Allow-Origin', origin!);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      'content-type,x-blode-token,x-blode-filename,x-blode-client',
    );
  };

  const authorized = (request: IncomingMessage, url: URL) =>
    (!options.requireToken && (!options.allowExternal || isLoopback(request.socket.remoteAddress))) ||
    url.searchParams.get('token') === token ||
    request.headers['x-blode-token'] === token;

  const send = (payload: string) => {
    for (const client of clients) {
      if (!client.writableEnded) client.write(payload);
    }
  };
  const publish = (input: LogEvent) => {
    const event = recentLogs.publish(input);
    send(`data: ${JSON.stringify(event)}\n\n`);
  };
  const publishCollaboration = (event: CollaborationEvent) =>
    send(`event: ${COLLABORATION_CHANNEL}\ndata: ${JSON.stringify(event)}\n\n`);
  const publishUiCommand = (request: UiRequest) =>
    send(`event: ${UI_COMMAND_CHANNEL}\ndata: ${JSON.stringify(request)}\n\n`);
  const publishDrafts = (drafts: Record<string, string>) => {
    latestDrafts = drafts;
    send(`event: drafts\ndata: ${JSON.stringify(drafts)}\n\n`);
  };

  const server: Server = createServer(async (request, response) => {
    let url: URL;
    try {
      if (!validHost(request.headers.host) || !request.url?.startsWith('/')) throw new Error('invalid host');
      const base = new URL(`http://${request.headers.host}`);
      url = new URL(request.url, base);
      if (url.origin !== base.origin) throw new Error('invalid authority');
    } catch {
      response.writeHead(400);
      response.end('invalid request authority');
      return;
    }
    cors(request, response);

    if (request.method === 'OPTIONS') {
      response.writeHead(validOrigin(request, url) ? 204 : 403);
      response.end();
      return;
    }
    if (url.pathname.startsWith('/runtime-ui/')) {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      response.setHeader('cache-control', 'no-store');
      response.setHeader('referrer-policy', 'no-referrer');
      response.setHeader('x-content-type-options', 'nosniff');
      const ticket = url.pathname.slice('/runtime-ui/'.length);
      const view = /^[a-f0-9]{48}$/.test(ticket) ? runtimeViews.get(ticket) : undefined;
      if (view) runtimeViews.delete(ticket);
      pruneRuntimeViews();
      if (!view || view.expiresAt <= Date.now() || !options.hostServices) {
        response.writeHead(404);
        response.end('Runtime view is no longer available.');
        return;
      }
      try {
        if (!validOrigin(request, url)) throw new Error('rpc.unauthorized');
        const html = await options.hostServices.invoke('runtimePluginView', [view.id, view.kind]);
        if (stopped) throw new Error('rpc.methodNotFound');
        if (typeof html !== 'string' || html.length > 1_000_000) throw new Error('error.runtimePluginResult');
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': RUNTIME_VIEW_CSP,
        });
        response.end(renderRuntimeView(html));
      } catch {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Runtime view is no longer available.');
      }
      return;
    }
    if (url.pathname === '/events') {
      if (!authorized(request, url) || !validOrigin(request, url)) {
        response.writeHead(401);
        response.end('unauthorized');
        return;
      }
      const id = clientId(url.searchParams.get('client'));
      if (url.searchParams.has('client') && !id) {
        response.writeHead(400);
        response.end('invalid client');
        return;
      }
      let owner: PageTransport | undefined;
      try {
        if (id) {
          owner = pageTransport(id);
          clearTimeout(owner.timer);
          clearTimeout(owner.retire);
          owner.closed = false;
          owner.streams.add(response);
        }
      } catch {
        response.writeHead(429);
        response.end('too many clients');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      clients.add(response);
      for (const event of recentLogs.snapshot()) response.write(`data: ${JSON.stringify(event)}\n\n`);
      if (Object.keys(latestDrafts).length)
        response.write(`event: drafts\ndata: ${JSON.stringify(latestDrafts)}\n\n`);
      response.on('close', () => {
        clients.delete(response);
        if (id && owner) {
          owner.streams.delete(response);
          if (!owner.streams.size) scheduleRelease(id, owner);
        }
      });
      return;
    }
    if (url.pathname.startsWith('/project/package/')) {
      if (request.method !== 'GET') {
        response.writeHead(405);
        response.end();
        return;
      }
      if (!authorized(request, url) || !validOrigin(request, url)) {
        response.writeHead(401);
        response.end('unauthorized');
        return;
      }
      const id = url.pathname.slice('/project/package/'.length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const artifact = await options.packageDownload?.(id);
        if (!artifact) {
          response.writeHead(404);
          response.end();
          return;
        }
        const info = await fs.stat(artifact.path);
        if (!info.isFile()) {
          response.writeHead(404);
          response.end();
          return;
        }
        const name = artifact.name.replace(/[\\/\x00-\x1f\x7f"]/g, '_');
        const ascii = name.replace(/[^\x20-\x7e]/g, '_');
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': info.size,
          'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        await pipeline(createReadStream(artifact.path), response);
      } catch {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(404);
          response.end();
        }
      }
      return;
    }
    if (url.pathname === '/debugger/symbols') {
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end();
        return;
      }
      if (!authorized(request, url) || !validOrigin(request, url)) {
        response.writeHead(401);
        response.end(JSON.stringify({ error: 'rpc.unauthorized' }));
        return;
      }
      try {
        if (!options.debugger) throw new Error('error.desktopOnly');
        if (request.headers['content-type'] !== 'application/octet-stream')
          throw new Error('rpc.invalidParams');
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of request) {
          total += chunk.length;
          if (total > 128 * 1024 * 1024) throw new Error('rpc.limitExceeded');
          chunks.push(Buffer.from(chunk));
        }
        const name = decodeURIComponent(String(request.headers['x-blode-filename'] ?? 'symbols.elf'));
        const result = await options.debugger.symbols(Buffer.concat(chunks), name);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (url.pathname === '/rpc') {
      if (request.method !== 'POST') {
        response.writeHead(405);
        response.end();
        return;
      }
      if (!authorized(request, url)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'rpc.unauthorized' }));
        return;
      }
      if (!validOrigin(request, url)) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'rpc.unauthorized' }));
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        response.writeHead(415, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'rpc.invalidParams' }));
        return;
      }
      try {
        const body = (await readBody(request)) as { method?: unknown; args?: unknown };
        if (typeof body.method !== 'string' || !Array.isArray(body.args))
          throw new Error('rpc.invalidRequest');
        const id = clientId(request.headers['x-blode-client']);
        if (request.headers['x-blode-client'] && !id) throw new Error('rpc.invalidParams');
        const page = id && body.method === 'collaborationPresence' ? pageTransport(id) : undefined;
        if (page?.closed && !page.streams.size) throw new Error('rpc.unauthorized');
        let result: unknown;
        if (body.method === 'runtimePluginViewDocument') {
          if (!options.hostServices) throw new Error('rpc.methodNotFound');
          if (
            body.args.length !== 2 ||
            typeof body.args[0] !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(body.args[0]) ||
            !['device', 'debugger'].includes(body.args[1] as string)
          )
            throw new Error('rpc.invalidParams');
          const [pluginId, kind] = body.args as [string, 'device' | 'debugger'];
          const html = await options.hostServices.invoke('runtimePluginView', [pluginId, kind]);
          if (stopped) throw new Error('rpc.methodNotFound');
          if (html === null) result = null;
          else {
            if (typeof html !== 'string' || html.length > 1_000_000)
              throw new Error('error.runtimePluginResult');
            pruneRuntimeViews();
            if (runtimeViews.size >= 64) throw new Error('rpc.limitExceeded');
            const ticket = randomBytes(24).toString('hex');
            runtimeViews.set(ticket, { id: pluginId, kind, expiresAt: Date.now() + 15_000 });
            result = `${url.origin}/runtime-ui/${ticket}`;
          }
        } else if (
          /^(?:aiAssistance|aiPrediction|collaboration|uiPublishState|uiCommandReply)/.test(body.method)
        ) {
          if (!options.assistance) throw new Error('rpc.methodNotFound');
          result = await options.assistance.invoke(body.method, body.args);
          if (page && body.method === 'collaborationPresence') {
            const input = body.args[0] as any,
              snapshot = result as any;
            if (
              typeof input?.identity?.peerId === 'string' &&
              typeof input.actorToken === 'string' &&
              typeof snapshot?.session === 'string'
            ) {
              const peer: BoundPeer = {
                peerId: input.identity.peerId,
                actorToken: input.actorToken,
                projectRoot: input.projectRoot,
                session: snapshot.session,
                ...(typeof input.sequence === 'number' ? { sequence: input.sequence } : {}),
              };
              const previous = page.peers.get(peer.peerId);
              if (
                !previous ||
                previous.session !== peer.session ||
                (peer.sequence ?? 0) >= (previous.sequence ?? 0)
              )
                page.peers.set(peer.peerId, peer);
              // A request finishing after its stream closed must not resurrect that page.
              if (page.closed && !page.streams.size) await releasePeers(page);
              else if (!page.streams.size && id) scheduleRelease(id, page);
            }
          } else if (id && body.method === 'collaborationLeave') {
            const input = body.args[0] as any,
              owner = pages.get(id),
              bound = owner?.peers.get(input?.peerId);
            if (
              bound &&
              input.actorToken === bound.actorToken &&
              input.session === bound.session &&
              (input.sequence ?? 0) >= (bound.sequence ?? 0)
            )
              owner!.peers.delete(bound.peerId);
          }
        } else if (body.method.startsWith('debugger')) {
          if (!options.debugger) throw new Error('rpc.methodNotFound');
          result = await options.debugger.invoke(body.method, body.args);
        } else if (isHostMethod(body.method)) {
          if (!options.hostServices) throw new Error('rpc.methodNotFound');
          result = await options.hostServices.invoke(body.method, body.args);
        } else result = await invoke(options.api, body.method, body.args);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result ?? null));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end();
      return;
    }
    if (!options.isPackaged && options.rendererUrl) {
      response.writeHead(302, { location: `${options.rendererUrl}${url.search}` });
      response.end();
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const target = path.resolve(staticRoot, relative);
    const within = path.relative(path.resolve(staticRoot), target);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const info = await fs.stat(target);
      if (!info.isFile()) throw new Error('not a file');
      const etag = `W/"${info.size}-${info.mtimeMs}"`;
      response.setHeader('etag', etag);
      response.setHeader(
        'cache-control',
        /^assets[\\/].+-[A-Za-z0-9_-]+\.(?:js|css|woff2?|ttf)$/.test(relative)
          ? 'public,max-age=31536000,immutable'
          : 'no-cache',
      );
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304);
        response.end();
        return;
      }
      const content = await fs.readFile(target);
      response.writeHead(200, {
        'content-type': mime[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      });
      response.end(content);
    } catch {
      try {
        const index = await fs.readFile(path.join(staticRoot, 'index.html'));
        response.writeHead(200, { 'content-type': mime['.html'] });
        response.end(index);
      } catch {
        response.writeHead(404);
        response.end('Blode renderer is not built. Run npm run build for browser mode.');
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? defaultPort, host, () => resolve());
  });
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : defaultPort;
  const heartbeat = setInterval(() => {
    for (const client of clients) if (!client.writableEnded) client.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref();

  return {
    endpoint: options.allowExternal ? lanEndpoint(listeningPort) : `http://127.0.0.1:${listeningPort}`,
    tokenFile,
    allowExternal: options.allowExternal,
    publish,
    publishDrafts,
    publishCollaboration,
    publishUiCommand,
    close: async () => {
      stopped = true;
      clearInterval(heartbeat);
      runtimeViews.clear();
      for (const page of pages.values()) {
        clearTimeout(page.timer);
        clearTimeout(page.retire);
        page.streams.clear();
      }
      await Promise.allSettled([...pages.values()].map(releasePeers));
      pages.clear();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
