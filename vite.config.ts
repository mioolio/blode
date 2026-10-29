import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',
  // Discover the optional editor before the first file is opened, so its deep
  // ESM dependencies do not trigger a second optimizer pass and a page reload.
  optimizeDeps: {
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
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.tools/**', '**/tools/**', '**/dist/**', '**/release/**', '**/.git/**'] },
  },
  build: { outDir: 'dist/renderer', emptyOutDir: true },
});
