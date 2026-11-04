import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { monacoHighlightCancellation } from './scripts/monaco-highlights.ts';
import { developmentHostApi } from './scripts/dev-host-api.ts';

export default defineConfig({
  plugins: [
    monacoHighlightCancellation(),
    react(),
    developmentHostApi(
      process.env.BLODE_DEV_API_ENDPOINT_FILE || path.resolve('.tools/dev-web-endpoint.json'),
    ),
  ],
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
    watch: { ignored: ['**/.tools/**', '**/tools/**', '**/dist/**', '**/release/**', '**/.git/**'] },
  },
  build: { outDir: path.join(process.env.BLODE_RELEASE_DIST || 'dist', 'renderer'), emptyOutDir: true },
});
