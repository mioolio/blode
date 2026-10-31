import { randomUUID } from 'node:crypto';
import type { Plugin, ViteDevServer } from 'vite';
import { developmentRendererUrl } from '../src/shared/development-url.ts';

/** A private readiness challenge distinguishes this Vite instance from an occupied port. */
export function createDevelopmentServerIdentity() {
  const challenge = randomUUID(),
    endpoint = `/__blode_dev_ready/${challenge}`;
  const plugin: Plugin = {
    name: 'blode-owned-development-server',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== endpoint) return next();
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(challenge);
      });
    },
  };
  return {
    plugin,
    async ready(server: ViteDevServer, fetcher: typeof fetch = fetch): Promise<string> {
      const address = server.httpServer?.address();
      if (
        !address ||
        typeof address === 'string' ||
        !['127.0.0.1', '0.0.0.0', '::'].includes(address.address)
      )
        throw new Error('error.invalidDevServer');
      const origin = developmentRendererUrl(`http://127.0.0.1:${address.port}`);
      const response = await fetcher(origin + endpoint, {
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if (!response.ok || (await response.text()) !== challenge) throw new Error('error.invalidDevServer');
      return origin;
    },
  };
}
