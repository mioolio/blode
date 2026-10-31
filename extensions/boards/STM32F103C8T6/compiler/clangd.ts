import type { ProjectConfig } from '../../../../src/shared/contracts.js';
import { parseKeilProject } from './keil.js';

export interface Stm32ClangdPlatform {
  flags: string[];
  includes: string[];
}

/**
 * The STM32 compiler owns the device profile. clangd must see the same target
 * and defines, but the Keil project is optional: exported projects often lose
 * .uvprojx while our own board profile still knows the density.
 */
export function stm32ClangdPlatform(
  files: readonly { path: string; content: string }[],
  _config: ProjectConfig,
): Stm32ClangdPlatform {
  const project = files.find((file) => /\.uvprojx$/i.test(file.path));
  let defines = new Set(['STM32F10X_MD']);
  let includes: string[] = [];
  if (project) {
    try {
      const keil = parseKeilProject(project.content, project.path);
      defines = new Set([...defines, ...keil.defines]);
      includes = keil.includes;
    } catch {
      /* A damaged optional Keil project must not disable the board profile. */
    }
  }
  return {
    flags: [
      '--target=arm-none-eabi',
      '-mcpu=cortex-m3',
      '-mthumb',
      '-mfloat-abi=soft',
      '-ffreestanding',
      ...[...defines].map((value) => `-D${value}`),
    ],
    includes,
  };
}
