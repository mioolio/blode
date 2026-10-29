import { createEsp32S3Runtime } from './boards/Esp32_S3_CAM/runtime/index.js';
import { createStm32Runtime } from './boards/STM32F103C8T6/runtime/index.js';
import type { CreatePlatformRuntimes } from './runtime.js';

/** Explicit registration is the only integration point for trusted platform code. */
export const createPlatformRuntimes: CreatePlatformRuntimes = (host) => [
  createEsp32S3Runtime(host),
  createStm32Runtime(host),
];
