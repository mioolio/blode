import { readFile } from 'node:fs/promises';
import { request as forwardRequest } from 'node:http';
import type { Plugin } from 'vite';

/** Boundary: the public development origin streams API/SSE to its private desktop backend; no browser-supplied proxy targets or tokens. */
export function developmentHostApi(endpointFile: string): Plugin {
  const paths = ['/rpc', '/events', '/workspace', '/extension-ui', '/runtime-ui', '/project', '/debugger'];
  return {
    name: 'blode-development-host-api',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = (request.url || '/').split('?')[0];
        if (!paths.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))) return next();
        const fail = (status: number, error: string) => {
          if (response.headersSent) return response.destroy();
          response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ error }));
        };
        let target: URL;
        try {
          if (request.headers.origin) {
            const origin = new URL(request.headers.origin);
            if (
              origin.origin !== request.headers.origin ||
              origin.origin !== new URL(`http://${request.headers.host}`).origin
            )
              return fail(403, 'Origin rejected');
          }
          if (request.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Origin rejected');
        } catch {
          return fail(403, 'Origin rejected');
        }
        try {
          const record = JSON.parse(await readFile(endpointFile, 'utf8'));
          target = new URL(record.endpoint);
          if (
            target.protocol !== 'http:' ||
            target.hostname !== '127.0.0.1' ||
            !target.port ||
            target.username ||
            target.password ||
            target.pathname !== '/' ||
            target.search ||
            target.hash ||
            !Number.isSafeInteger(record.pid) ||
            record.pid < 1
          )
            throw new Error('Invalid private endpoint');
          process.kill(record.pid, 0); // Existence check only: never forward to a retired desktop's stale port.
        } catch {
          return fail(503, 'Desktop backend is not ready');
        }
        const headers = {
          ...request.headers,
          host: target.host,
          'x-blode-development-origin': new URL(`http://${request.headers.host}`).origin,
        };
        delete headers.origin;
        delete headers.referer;
        const upstream = forwardRequest(
          target,
          { method: request.method, path: request.url, headers },
          (incoming) => {
            response.writeHead(incoming.statusCode || 502, incoming.headers);
            incoming.on('error', () => response.destroy());
            incoming.pipe(response);
          },
        );
        upstream.on('error', () => fail(502, 'Desktop backend is unavailable'));
        request.on('aborted', () => upstream.destroy());
        response.on('close', () => upstream.destroy());
        request.pipe(upstream);
      });
    },
  };
}
