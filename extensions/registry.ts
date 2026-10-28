import { autoAdapter } from './boards/auto/adapter.js';
import { esp32S3Adapter } from './boards/esp32-s3/adapter.js';
import { stm32Adapter } from './boards/stm32/adapter.js';
import type { BoardAdapter } from './types.js';

// Explicit registration keeps untrusted workspace manifests from executing in the main process.
// Every chip model lives under extensions/boards/<id>; an unregistered id is rejected.
const adapters = new Map<string, BoardAdapter>(
  [autoAdapter, esp32S3Adapter, stm32Adapter].map((adapter) => [adapter.definition.id, adapter]),
);

export function getBoardAdapter(id: string): BoardAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error('errors.unknownBoard');
  return adapter;
}

export function listBoards() {
  return [...adapters.values()].map((adapter) => structuredClone(adapter.definition));
}
