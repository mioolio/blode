import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { monacoHighlightCancellation } from './scripts/monaco-highlights.ts';

// LAN and public browsers reach the desktop host API through this development
// origin, so the desktop port stays loopback-only and no token has to be shared.
const hostApi = (): ProxyOptions => ({
  target: 'http://127.0.0.1:47821',
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (request) => {
      // The host API only accepts its own or loopback origins; the proxy is the
      // client, so the browser's origin must not be forwarded.
      request.removeHeader('origin');
      request.removeHeader('referer');
    });
  },
});
const hostApiPaths = ['/rpc', '/events', '/workspace', '/extension-ui', '/runtime-ui', '/project', '/debugger'];

export default defineConfig({
  plugins: [monacoHighlightCancellation(), react()],
  base: './',
  // Discover the optional editor before the first file is opened, so its deep
  // ESM dependencies do not trigger a second optimizer pass and a page reload.
  optimizeDeps: {
    rolldownOptions: { plugins: [monacoHighlightCancellation()] },
    // The application has one HTML entry. Do not crawl bundled toolchain SDKs
    // and their documentation to find unrelated HTML/JavaScript dependencies.
    entries: ['index.html'],
    include: [
      // Module language schemas are also loaded by optional editor panels.
      // Keep their validator in the initial batch instead of reloading the UI.
      'zod',
      '@monaco-editor/react',
      'monaco-editor/esm/vs/editor/editor.api.js',
      'monaco-editor/esm/vs/editor/editor.all.js',
      'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js',
      'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js',
      'monaco-editor/esm/vs/basic-languages/python/python.contribution.js',
      'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js',
      'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js',
      'monaco-editor/esm/vs/language/json/monaco.contribution.js',
      'monaco-editor/esm/vs/language/typescript/monaco.contribution.js',
    ],
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5173,
    strictPort: false,
    proxy: Object.fromEntries(hostApiPaths.map((prefix) => [prefix, hostApi()])),
    watch: { ignored: ['**/.tools/**', '**/tools/**', '**/dist/**', '**/release/**', '**/.git/**'] },
  },
  build: { outDir: path.join(process.env.BLODE_RELEASE_DIST || 'dist', 'renderer'), emptyOutDir: true },
});
