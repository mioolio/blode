import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export async function stageArchiveTools(output) {
  const source = fileURLToPath(new URL('../vendor/7zip/', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  const sourceArchive = await fs.readFile(path.join(source, '7z2605-src.tar.xz'));
  if (createHash('sha256').update(sourceArchive).digest('hex') !== manifest.sourceSha256)
    throw new Error('Bundled 7-Zip source checksum mismatch');
  const entry = manifest.platforms[`${process.platform}-${process.arch}`];
  if (entry) {
    const bytes = await fs.readFile(path.join(source, entry.file));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error('Bundled 7-Zip checksum mismatch');
  }
  const destination = path.resolve(output, 'archive-tools');
  await fs.mkdir(destination, { recursive: true });
  for (const name of [
    'manifest.json',
    'License.txt',
    'COPYING.LGPL-2.1.txt',
    'readme.txt',
    'README.md',
    '7z2605-src.tar.xz',
    ...(entry ? [entry.file] : []),
  ]) {
    const target = path.join(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, name), target);
  }
}
