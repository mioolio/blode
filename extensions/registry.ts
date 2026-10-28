import { esp32S3Adapter } from './boards/esp32-s3/adapter.js';
import { genericAdapter } from './boards/generic/adapter.js';
import type { BoardAdapter } from './types.js';

// Explicit registration keeps untrusted workspace manifests from executing in the main process.
const adapters = new Map<string, BoardAdapter>(
  [esp32S3Adapter, genericAdapter].map((adapter) => [adapter.definition.id, adapter]),
);

export function getBoardAdapter(id: string): BoardAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error('errors.unknownBoard');
  return adapter;
}

export function listBoards() {
  return [...adapters.values()].map((adapter) => structuredClone(adapter.definition));
}
