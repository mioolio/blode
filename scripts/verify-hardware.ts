/** Explicit integration runner. --flash is required before any firmware is written. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCore } from '../src/core/service';
import { parseProjectDescriptor } from '../src/core/config';

const args = new Set(process.argv.slice(2));
for (const argument of args)
  if (!['--install', '--flash'].includes(argument))
    throw new Error(`Unknown hardware verification option: ${argument}`);
const requestedProject = process.env.BLODE_PROJECT_ROOT?.trim();
if (!requestedProject)
  throw new Error(
    'Set BLODE_PROJECT_ROOT to an existing Blode project outside this application repository before running hardware verification.',
  );
const repository = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const projectRoot = await fs.realpath(path.resolve(requestedProject));
if (!(await fs.stat(projectRoot)).isDirectory())
  throw new Error('BLODE_PROJECT_ROOT must be an existing project directory.');
const relativeProject = path.relative(repository, projectRoot);
if (
  relativeProject === '' ||
  (relativeProject !== '..' &&
    !relativeProject.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeProject))
)
  throw new Error('BLODE_PROJECT_ROOT must be outside the Blode Studio application repository.');
// Validate an existing descriptor before createCore can initialize any defaults.
// Legacy projects may keep their configuration behind an empty `be` marker.
const marker = await fs
  .readFile(path.join(projectRoot, 'be'), 'utf8')
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
const descriptor =
  marker.trim() || (await fs.readFile(path.join(projectRoot, '.blode', 'project.json'), 'utf8'));
parseProjectDescriptor(JSON.parse(descriptor));
const dataRoot =
  process.env.BLODE_DATA_ROOT ||
  path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Blode Studio');
const log: string[] = [];
const logDirectory = path.join(repository, '.tools');
await fs.mkdir(logDirectory, { recursive: true });
console.log(`Hardware verification project: ${projectRoot}`);
const core = await createCore({
  projectRoot,
  dataRoot,
  onEvent: (event) => {
    const line = `[${event.time}] [${event.level}] ${event.message}`;
    log.push(line);
    console.log(line);
  },
});
try {
  const state = await core.getState();
  if (process.env.BLODE_PORT !== undefined)
    await core.saveConfig({ ...state.config, port: process.env.BLODE_PORT });
  if (args.has('--install')) await core.installToolchain();
  await core.probe();
  const result = await core.build();
  console.log(JSON.stringify({ ...result, output: undefined }, null, 2));
  if (!result.success) throw new Error('Build failed');
  if (args.has('--flash')) await core.flash();
} finally {
  await core.shutdown();
  await fs.writeFile(path.join(logDirectory, 'hardware-run.log'), log.join('\n') + '\n', 'utf8');
}
