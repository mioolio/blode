import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signDirectory } from './sign-packages';

export async function signNativeTools(directory: string, id: string, version: string) {
  if (process.platform !== 'win32') throw new Error('Authenticode signing requires Windows.');
  const repository = fileURLToPath(new URL('..', import.meta.url));
  directory = path.resolve(directory);
  const bin = path.join(directory, 'bin');
  const backup = await fs.mkdtemp(path.join(repository, '.signing', 'native-backup-'));
  const records: { file: string; result: string }[] = [];
  for (const item of await fs.readdir(bin, { withFileTypes: true })) {
    if (!/\.(?:exe|dll)$/i.test(item.name)) continue;
    const file = path.join(bin, item.name),
      info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
      throw new Error('Invalid native tool path.');
    await fs.copyFile(file, path.join(backup, item.name));
    const { stdout } = await promisify(execFile)(
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
        file,
      ],
      { windowsHide: true },
    );
    records.push({ file: item.name, result: stdout.trim() });
  }
  await signDirectory(bin, { kind: 'tool', id: id + '/bin', version });
  await signDirectory(directory, { kind: 'tool', id, version });
  await fs.writeFile(
    path.join(backup, 'report.json'),
    JSON.stringify({ directory, id, version, signedAt: new Date().toISOString(), records }, null, 2) + '\n',
  );
  return { backup, records };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(await signNativeTools(process.argv[2], process.argv[3], process.argv[4]));
