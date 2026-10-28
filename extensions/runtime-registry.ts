import { createEsp32S3Runtime } from './boards/esp32-s3/runtime.js';
import { createStm32Runtime } from './boards/stm32/runtime.js';
import type { CreatePlatformRuntimes } from './runtime.js';

/** Explicit registration is the only integration point for trusted platform code. */
export const createPlatformRuntimes: CreatePlatformRuntimes = (host) => [
  createEsp32S3Runtime(host),
  createStm32Runtime(host),
];
