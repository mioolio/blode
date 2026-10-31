import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashSignedDirectory,
  publisherKeyId,
  signObe,
  verifyPackageDirectory,
  verifyPackageArtifact,
} from '../src/core/package-signing';
import type { PackageSubject } from '../src/shared/package-signing';

const repository = fileURLToPath(new URL('..', import.meta.url));
const home = path.join(repository, '.signing');
export const signingKeyFile = () =>
  process.env.BLODE_SIGNING_KEY || path.join(home, 'blode-studio-ed25519.pem');
export async function initializeSigning() {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync(
      'icacls.exe',
      [home, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
      { windowsHide: true, stdio: 'pipe' },
    );
  }
  const keyFile = signingKeyFile();
  if (await fs.stat(keyFile).catch(() => null))
    throw new Error('Signing identity already exists; it was not replaced.');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await fs.writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  });
  const identity = { publisher: 'Blode Studio', keyId: publisherKeyId(pem), publicKey: pem };
  await fs.writeFile(
    path.join(repository, 'src/shared/package-publishers.json'),
    JSON.stringify({ version: 1, keys: [identity] }, null, 2) + '\n',
  );
  await fs.writeFile(
    path.join(home, 'README.md'),
    '# Blode Studio signing identity\n\nPrivate maintainer keys. Back up this directory securely. Never include it in a repository, application, component or tool archive. Only the public key in src/shared/package-publishers.json is distributed.\n',
  );
  return identity;
}
export async function signDirectory(root: string, subject: PackageSubject, keyFile = signingKeyFile()) {
  const metadata = await fs.readFile(path.join(root, 'manifest.json'), 'utf8').catch(() => '');
  if (metadata) {
    const manifest = JSON.parse(metadata);
    if (manifest.id !== subject.id || manifest.version !== subject.version)
      throw new Error('Signing identity/version must match manifest.json.');
  }
  const { records } = await hashSignedDirectory(root, {
    exclude: (relative, directory) =>
      relative
        .split('/')
        .some(
          (part) =>
            part.startsWith('.') ||
            /^(?:node_modules|cache|caches|logs|tmp|temp|__pycache__|verify)$/i.test(part),
        ) ||
      (!directory &&
        /(?:\.(?:key|pem|pfx|p12|lic|licx|log|pyc)|^(?:TOOLS\.INI|license\.dat))$/i.test(
          path.basename(relative),
        )),
  });
  const key = await fs.readFile(keyFile, 'utf8');
  await fs.writeFile(path.join(root, 'obe'), signObe(records, subject, key));
  return { files: records.length, subject };
}
export async function signMaintainerDirectory(root: string, subject: PackageSubject) {
  if (await fs.stat(signingKeyFile()).catch(() => null)) return signDirectory(root, subject);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, kind, id, version] = process.argv.slice(2);
  if (command === 'init') console.log(await initializeSigning());
  else if (command === 'verify' && root) {
    const source = path.resolve(root);
    console.log(
      (await fs.lstat(source)).isFile()
        ? await verifyPackageArtifact(source)
        : await verifyPackageDirectory(source),
    );
  } else if (command === 'sign' && root && kind && id && version)
    console.log(
      await signDirectory(path.resolve(root), { kind: kind as PackageSubject['kind'], id, version }),
    );
  else
    throw new Error(
      'Usage: tsx scripts/sign-packages.ts init | sign <directory> <kind> <id> <version> | verify <directory>',
    );
}
