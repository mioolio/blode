import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { webCliHelp } from '../src/shared/web-cli';
import { readZip } from '../src/core/zip-reader';
import { defaultWebDataRoot } from '../src/core/web-data-root';

/**
 * Packaged Web-edition launcher.
 *
 * The executable carries the browser build, the Node host and the native
 * SerialPort/PTY runtime inside one deflated ZIP asset. On first start the
 * payload is extracted next to the host data, then the ordinary standalone
 * host is compiled from that directory so `require('serialport')` and the
 * static renderer keep their normal on-disk layout.
 */

declare const __BLODE_RELEASE_VERSION__: string | undefined;

const RELEASE_VERSION =
  typeof __BLODE_RELEASE_VERSION__ === 'string' ? __BLODE_RELEASE_VERSION__ : '0.0.0-dev';
const BUNDLE_ASSET = 'bundle.zip';
const BUNDLE_MARKER = '.bundle';
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const INSTALL_RETRIES = 5;

export interface BootstrapOptions {
  /** Arguments forwarded to the standalone host, without launcher-only flags. */
  serverArgs: string[];
  /** The packaged edition hands the launch link to the default browser by default. */
  openBrowser: boolean;
}

/** Split launcher flags from host flags without rewriting any host option. */
export function bootstrapOptions(args: string[]): BootstrapOptions {
  const serverArgs: string[] = [];
  let open = true;
  for (const arg of args) {
    if (arg === '--no-open') {
      open = false;
      continue;
    }
    if (arg === '--open') {
      open = true;
      continue;
    }
    serverArgs.push(arg);
  }
  if (serverArgs.includes('--help') || serverArgs.includes('-h')) open = false;
  return { serverArgs, openBrowser: open };
}

/**
 * Resolve the same data directory the host would use, before the host is
 * loaded. The launcher needs it to place the extracted runtime cache.
 */
export function bootstrapDataRoot(
  serverArgs: string[],
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const index = serverArgs.indexOf('--data-root');
  const explicit = index >= 0 && !serverArgs[index + 1]?.startsWith('--') ? serverArgs[index + 1] : '';
  return path.resolve(explicit || environment.BLODE_DATA_ROOT || defaultWebDataRoot());
}

/** Immutable runtime directory keyed by the payload hash. */
export function runtimeDirectory(dataRoot: string, bundleHash: string): string {
  return path.join(dataRoot, 'runtime', `bundle-${bundleHash.slice(0, 16)}`);
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const markerContent = (directory: string): Promise<string> =>
  fs.readFile(path.join(directory, BUNDLE_MARKER), 'utf8').catch(() => '');

async function extractBundle(bundle: Buffer, temporary: string): Promise<number> {
  let files: Map<string, Buffer>;
  try {
    files = readZip(bundle, {
      maxArchive: MAX_BUNDLE_BYTES,
      invalidError: 'error.webBundleRead',
      tooLargeError: 'error.webBundleTooLarge',
    });
  } catch (error) {
    // Keep the reader's reason (invalid vs. too large) for the console line.
    throw new Error(error instanceof Error ? error.message : 'error.webBundleRead');
  }
  let bytes = 0;
  for (const [name, data] of files) {
    const target = path.join(temporary, ...name.split('/'));
    if (!target.startsWith(temporary + path.sep)) throw new Error('error.webBundlePath');
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      throw new Error(`error.webBundleWrite ${name} (${code})`);
    }
    bytes += data.length;
  }
  return bytes;
}

/**
 * Windows antivirus scanners can hold freshly written native binaries for a
 * moment; installing a directory therefore retries the final rename instead
 * of failing the whole first start.
 */
async function installDirectory(temporary: string, directory: string): Promise<void> {
  for (let attempt = 0; attempt < INSTALL_RETRIES; attempt++) {
    try {
      await fs.rename(temporary, directory);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'].includes(code ?? ''))
        throw new Error(`error.webBundleInstall (${code ?? 'unknown'})`);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      await wait(120 * (attempt + 1));
    }
  }
  throw new Error('error.webBundleInstall');
}

async function ensureRuntime(bundle: Buffer, dataRoot: string): Promise<string> {
  const hash = createHash('sha256').update(bundle).digest('hex');
  const directory = runtimeDirectory(dataRoot, hash);
  if ((await markerContent(directory)).trim() === hash) return directory;

  const temporary = `${directory}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(temporary, { recursive: true, force: true });
  const bytes = await extractBundle(bundle, temporary);
  await fs.writeFile(path.join(temporary, BUNDLE_MARKER), hash + '\n', 'utf8');
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  await installDirectory(temporary, directory);
  // A concurrent instance may have won the same immutable directory.
  if ((await markerContent(directory)).trim() !== hash) throw new Error('error.webBundleInstall');
  process.stdout.write(
    `Prepared Blode Studio Web ${RELEASE_VERSION} runtime (${(bytes / 1048576).toFixed(1)} MiB).\n`,
  );
  return directory;
}

async function loadHost(runtimeRoot: string, serverArgs: string[], openBrowser: boolean): Promise<void> {
  const serverFile = path.join(runtimeRoot, 'dist', 'web-server.cjs');
  const code = await fs.readFile(serverFile, 'utf8');
  // The host derives its asset root from argv[1]; pretending to be the script
  // keeps `web-server.ts` unchanged and points it at the extracted directory.
  process.argv = [process.execPath, serverFile, ...serverArgs];
  process.env.BLODE_WEB_OPEN_BROWSER = openBrowser ? '1' : '0';
  const hostModule = new Module(serverFile, undefined as unknown as Module);
  hostModule.filename = serverFile;
  hostModule.paths = (
    Module as unknown as { _nodeModulePaths: (directory: string) => string[] }
  )._nodeModulePaths(path.dirname(serverFile));
  (hostModule as unknown as { _compile: (code: string, file: string) => void })._compile(code, serverFile);
}

function requireSeaBundle(): Buffer {
  if (!isSea()) throw new Error('error.webBundleNotPackaged');
  // `getAsset` returns an ArrayBuffer unless an encoding string is requested.
  return Buffer.from(getAsset(BUNDLE_ASSET));
}

async function main(): Promise<void> {
  const { serverArgs, openBrowser } = bootstrapOptions(process.argv.slice(2));
  if (serverArgs.includes('--version') || serverArgs.includes('-v')) {
    process.stdout.write(`Blode Studio Web ${RELEASE_VERSION}\n`);
    return;
  }
  // Help must not touch the disk: print the shared description immediately.
  if (serverArgs.includes('--help') || serverArgs.includes('-h')) {
    process.stdout.write(
      webCliHelp(RELEASE_VERSION, { program: 'Blode Studio Web executable', launcher: true }),
    );
    return;
  }
  const bundle = requireSeaBundle();
  const dataRoot = bootstrapDataRoot(serverArgs);
  const runtimeRoot = await ensureRuntime(bundle, dataRoot);
  await loadHost(runtimeRoot, serverArgs, openBrowser);
}

const invokedDirectly = /web-bootstrap\.(?:cjs|mjs|js)$/i.test(path.basename(process.argv[1] ?? ''));
if (isSea() || invokedDirectly)
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Blode Studio Web could not start: ' + message);
    if (/^error\.webBundle(?:Write|Install)/.test(message))
      console.error(
        'The launcher could not write its runtime into the data folder. ' +
          'Use --data-root with a writable folder, or check the folder permissions.',
      );
    if (process.stdin.isTTY) {
      // Explorer closes a console as soon as the process exits. Keep the window
      // open for the reason and the hint instead of flashing once and vanishing.
      process.stdout.write('Press Enter to close this window.\n');
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(1));
      return;
    }
    process.exitCode = 1;
  });
