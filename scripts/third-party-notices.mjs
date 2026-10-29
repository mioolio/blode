import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const packages = new Map();
async function visit(name, from, optional = false) {
  let directory = from;
  let location;
  while (true) {
    const candidate = path.join(directory, 'node_modules', name, 'package.json');
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) {
      location = candidate;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!location) {
    if (optional) return;
    throw new Error(`Missing installed runtime dependency: ${name}`);
  }
  const info = JSON.parse(await fs.readFile(location, 'utf8'));
  const key = `${info.name} ${info.version}`;
  if (packages.has(key)) return;
  const packageRoot = path.dirname(location);
  packages.set(key, { info, root: packageRoot });
  for (const dependency of Object.keys(info.dependencies ?? {}))
    await visit(dependency, packageRoot, !!info.optionalDependencies?.[dependency]);
  for (const dependency of Object.keys(info.optionalDependencies ?? {}))
    await visit(dependency, packageRoot, true);
}
for (const name of Object.keys(metadata.dependencies)) await visit(name, root);
const sections = [
  '# Third-party notices',
  '',
  'Blode Studio is licensed under Apache-2.0. The following notices cover installed runtime dependencies and the bundled XML parser. Native packages retain their own license files. Electron includes Chromium notices in the desktop distribution. Regenerate this file with `node scripts/third-party-notices.mjs` after installing dependencies.',
  '',
];
for (const [key, entry] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  sections.push(
    `## ${key}`,
    '',
    `Declared license: ${typeof entry.info.license === 'string' ? entry.info.license : JSON.stringify(entry.info.license)}`,
    '',
  );
  const names = (await fs.readdir(entry.root)).filter((file) =>
    /^(?:licen[cs]e(?:\..*)?|copying(?:\..*)?|notice(?:\..*)?|thirdpartynotices(?:\..*)?)$/i.test(file),
  );
  if (!names.length) throw new Error(`Missing license notice: ${key}`);
  for (const name of names.sort()) {
    const file = path.join(entry.root, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    sections.push(`### ${name}`, '', '```text', (await fs.readFile(file, 'utf8')).trim(), '```', '');
  }
}
sections.push(
  '## @xmldom/xmldom 0.8.15 (bundled)',
  '',
  'Declared license: MIT',
  '',
  '```text',
  (
    await fs.readFile(path.join(root, 'extensions/boards/STM32F103C8T6/vendor/LICENSE.xmldom'), 'utf8')
  ).trim(),
  '```',
  '',
);
await fs.writeFile(path.join(root, 'docs/THIRD-PARTY-NOTICES.md'), sections.join('\n'));
console.log(`Generated notices for ${packages.size} runtime packages and the bundled XML parser.`);
