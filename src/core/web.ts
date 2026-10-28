import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CoreApi, LogEvent, ProjectConfig } from '../shared/contracts';

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
  api: CoreApi;
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
  close(): Promise<void>;
}

const isLoopback = (address?: string) =>
  !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

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
      );
    case 'serialClose':
      return api.serialClose();
    case 'serialWrite':
      return api.serialWrite(String(args[0]));
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
  let latestDrafts: Record<string, string> = {};
  const staticRoot = path.join(options.appRoot, 'dist', 'renderer');

  const allowedOrigin = (origin?: string) =>
    !!origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);

  const cors = (request: IncomingMessage, response: ServerResponse) => {
    const origin = request.headers.origin;
    if (allowedOrigin(origin)) response.setHeader('Access-Control-Allow-Origin', origin!);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type,x-blode-token');
  };

  const authorized = (request: IncomingMessage, url: URL) =>
    !options.allowExternal ||
    isLoopback(request.socket.remoteAddress) ||
    url.searchParams.get('token') === token ||
    request.headers['x-blode-token'] === token;

  const send = (payload: string) => {
    for (const client of clients) {
      if (!client.writableEnded) client.write(payload);
    }
  };
  const publish = (event: LogEvent) => send(`data: ${JSON.stringify(event)}\n\n`);
  const publishDrafts = (drafts: Record<string, string>) => {
    latestDrafts = drafts;
    send(`event: drafts\ndata: ${JSON.stringify(drafts)}\n\n`);
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    cors(request, response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/events') {
      if (!authorized(request, url)) {
        response.writeHead(401);
        response.end('unauthorized');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      clients.add(response);
      if (Object.keys(latestDrafts).length)
        response.write(`event: drafts\ndata: ${JSON.stringify(latestDrafts)}\n\n`);
      request.on('close', () => clients.delete(response));
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
      try {
        const body = (await readBody(request)) as { method?: unknown; args?: unknown };
        if (typeof body.method !== 'string' || !Array.isArray(body.args))
          throw new Error('rpc.invalidRequest');
        const result = await invoke(options.api, body.method, body.args);
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
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.resolve(staticRoot, relative);
    if (!target.startsWith(path.resolve(staticRoot))) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
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
    server.listen(defaultPort, host, () => resolve());
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) if (!client.writableEnded) client.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref();

  return {
    endpoint: options.allowExternal ? lanEndpoint(defaultPort) : `http://127.0.0.1:${defaultPort}`,
    tokenFile,
    allowExternal: options.allowExternal,
    publish,
    publishDrafts,
    close: async () => {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
