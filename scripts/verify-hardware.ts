/** Explicit integration runner. --flash is required before any firmware is written. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCore } from '../src/core/service';
import { createDefaultPartitions } from '../extensions/boards/esp32-s3/partitions';

const args = new Set(process.argv.slice(2));
const dataRoot =
  process.env.BLODE_DATA_ROOT ||
  path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Blode Studio');
const projectRoot = path.resolve('.tools/hardware-workspace/Blink');
const log: string[] = [];
await fs.mkdir('.tools', { recursive: true });
await fs.mkdir(projectRoot, { recursive: true });
await fs.cp(path.resolve('examples/blink'), projectRoot, {
  recursive: true,
  filter: (source) => !source.split(path.sep).includes('.blode'),
});
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
  const config = structuredClone(state.config);
  config.name = 'ESP32-S3 heartbeat';
  config.port = process.env.BLODE_PORT || 'COM3';
  config.flashSize = 16 * 1_048_576;
  config.partitions = createDefaultPartitions(config.flashSize);
  config.toolchain.python = '';
  await core.saveConfig(config);
  if (args.has('--install')) await core.installToolchain();
  const probe = await core.probe();
  if (!/ESP32-S3/i.test(probe)) throw new Error('Expected physical ESP32-S3');
  const result = await core.build();
  console.log(JSON.stringify({ ...result, output: undefined }, null, 2));
  if (!result.success) throw new Error('Build failed');
  if (args.has('--flash')) {
    await core.flash();
    await core.serialOpen(config.port, 115200);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    await core.serialClose();
  }
} finally {
  await core.shutdown();
  await fs.writeFile('.tools/hardware-run.log', log.join('\n') + '\n', 'utf8');
}
