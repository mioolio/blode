import { autoAdapter } from './boards/auto/adapter.js';
import { esp32S3Adapter } from './boards/Esp32_S3_CAM/device/adapter.js';
import { stm32Adapter } from './boards/STM32F103C8T6/device/adapter.js';
import type { BoardAdapter } from './types.js';
import { canonicalBoardId } from '../src/shared/runtime-identity.js';
export { canonicalBoardId };

// Explicit registration keeps untrusted workspace manifests from executing in the main process.
// Every chip model lives under extensions/boards/<id>; an unregistered id is rejected.
const adapters = new Map<string, BoardAdapter>(
  [autoAdapter, esp32S3Adapter, stm32Adapter].map((adapter) => [adapter.definition.id, adapter]),
);

export function getBoardAdapter(id: string): BoardAdapter {
  const adapter = adapters.get(canonicalBoardId(id));
  if (!adapter) throw new Error('errors.unknownBoard');
  return adapter;
}

export function listBoards() {
  return [...adapters.values()].map((adapter) => structuredClone(adapter.definition));
}

/** Register a declarative extension without allowing it to replace a built-in or alias. */
export function registerBoardAdapter(adapter: BoardAdapter): () => void {
  const id = adapter.definition.id;
  if (canonicalBoardId(id) !== id || adapters.has(id)) throw new Error('error.runtimePluginDuplicate');
  adapters.set(id, adapter);
  return () => {
    if (adapters.get(id) === adapter) adapters.delete(id);
  };
}
