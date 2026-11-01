import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hashSignedDirectory, signObe } from '../src/core/package-signing';
import { distributionFileExcluded, verifyDistribution } from '../src/core/distribution-integrity';
import { signingKeyFile } from './sign-packages';
import { RELEASE_VERSION } from '../src/shared/version';

const repository = fileURLToPath(new URL('..', import.meta.url));
export async function signDistribution(directory: string) {
  // All payload files, including native binaries, are covered by the signed manifest.
  // Preserve third-party publisher signatures inside the Electron distribution.
  const executable = path.join(directory, 'Blode Studio.exe');
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(repository, 'scripts/windows-code-signing.ps1'),
      '-Action',
      'Sign',
      '-TargetFile',
      executable,
      '-ReplaceSignature',
    ],
    { windowsHide: true },
  );
  await fs.copyFile(
    path.join(repository, 'build/protected-policy.txt'),
    path.join(directory, 'DISTRIBUTION-POLICY.txt'),
  );
  const { records } = await hashSignedDirectory(directory, { exclude: distributionFileExcluded });
  const key = await fs.readFile(signingKeyFile(), 'utf8');
  await fs.writeFile(
    path.join(directory, 'obe'),
    signObe(records, { kind: 'application', id: 'Blode.Studio.Protected', version: RELEASE_VERSION }, key),
  );
  await verifyDistribution(directory);
  console.log(`Protected distribution: ${records.length} files signed and verified.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await signDistribution(path.resolve(process.argv[2]));
