import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signingKeyFile } from './sign-packages';
import { signObe } from '../src/core/package-signing';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function signRelease(file: string, version: string) {
  if (!(await fs.stat(signingKeyFile()).catch(() => null))) return false;
  if (
    process.platform === 'win32' &&
    /\.exe$/i.test(file) &&
    (await fs.stat(path.join(root, '.signing/windows-signing.json')).catch(() => null))
  ) {
    const output = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(root, 'scripts/windows-code-signing.ps1'),
        '-Action',
        'Sign',
        '-TargetFile',
        file,
        '-ReplaceSignature',
      ],
      { windowsHide: true },
    );
    process.stdout.write(output.stdout);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const record = { path: path.basename(file), size: (await fs.stat(file)).size, sha256: hash.digest('hex') };
  const key = await fs.readFile(signingKeyFile(), 'utf8');
  await fs.writeFile(
    file + '.obe',
    signObe([record], { kind: 'application', id: 'Blode.Studio', version }, key),
  );
  console.log('Blode Studio signature: ' + file + '.obe');
  return true;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await signRelease(path.resolve(process.argv[2]), process.argv[3]);
