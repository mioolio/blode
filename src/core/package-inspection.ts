import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readDevicePackage } from './device-package-source';
import { readExtensionSource } from './general-extensions/package';
import { readComponentDirectory, unwrapComponentFiles } from './components';
import { readComponentZip } from './component-zip';
import { verifyPackageFiles, verifyPackageArtifact } from './package-signing';
import type { PackageKind } from '../shared/package-signing';

export async function inspectSmallPackage(source: string, kind: PackageKind) {
  if (!path.isAbsolute(source)) throw new Error('error.invalidArguments');
  if (kind === 'application') return verifyPackageArtifact(source);
  if (kind === 'device') {
    const pack = await readDevicePackage(source);
    return verifyPackageFiles(pack.files, { kind, id: pack.manifest.id, version: pack.manifest.version });
  }
  if (kind === 'extension') {
    const pack = await readExtensionSource(source);
    return verifyPackageFiles(pack.files, { kind, id: pack.manifest.id, version: pack.manifest.version });
  }
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.size > 256_000_000)))
    throw new Error('error.componentPath');
  const files = stat.isDirectory()
    ? await readComponentDirectory(source)
    : unwrapComponentFiles(readComponentZip(await fs.readFile(source), { maxArchive: 256_000_000 }));
  return verifyPackageFiles(files, { kind: 'component' });
}
