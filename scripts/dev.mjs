import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
// Refuse to attach to another dev server or accidentally launch a second desktop instance.
let portInUse = false;
try { await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(1000) }); portInUse = true; } catch {}
if (portInUse) throw new Error('The development server is already running on port 5173. Close the existing Blode Studio development session first.');
const children = [];
const stop = () => {
  for (const child of children) child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
await import('./build.mjs');
const vite = spawn(
  process.execPath,
  [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1'],
  { stdio: 'inherit' },
);
children.push(vite);
let viteExited = false;
vite.on('exit', () => { viteExited = true; });
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
  if (viteExited) break;
  try {
    if ((await fetch('http://127.0.0.1:5173')).ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) {
  stop();
  throw new Error('Vite did not start');
}
const { ELECTRON_RUN_AS_NODE: _, ...environment } = process.env;
const electron = spawn(require('electron'), ['.'], {
  stdio: 'inherit',
  env: { ...environment, ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173' },
});
children.push(electron);
electron.on('exit', (code) => {
  stop();
  process.exit(code ?? 0);
});
