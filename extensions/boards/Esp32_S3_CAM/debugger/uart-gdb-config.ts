import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Generic Espressif GDB needs its matching S3 CPU plugin when the UART stub has no target.xml. */
export async function esp32UartGdbEnvironment(
  executable: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  delete environment.XTENSA_GNU_CONFIG;
  const plugin = path.resolve(path.dirname(executable), '..', 'lib', 'xtensa_esp32s3.so');
  if ((await fs.stat(plugin).catch(() => null))?.isFile()) {
    environment.XTENSA_GNU_CONFIG = plugin;
    return environment;
  }
  // Older distributions ship a dedicated, statically configured S3 debugger.
  if (/^xtensa-esp32s3-elf-gdb(?:-no-python)?(?:\.exe)?$/i.test(path.basename(executable)))
    return environment;
  throw new Error('error.debuggerUartGdbConfig');
}
