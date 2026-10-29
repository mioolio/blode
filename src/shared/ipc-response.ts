// Expected shutdown cancellation is data on the Electron wire. Re-throw it in
// preload so callers retain rejection semantics without ipcMain's error log.
export const IPC_CANCELLED = { __blodeIpcCancelled: true } as const;

export async function withIpcCancellation<T>(operation: () => T | Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === 'error.operationCancelled') return IPC_CANCELLED;
    throw error;
  }
}

export function unwrapIpcResponse<T>(value: T): T {
  if (
    value &&
    typeof value === 'object' &&
    '__blodeIpcCancelled' in value &&
    value.__blodeIpcCancelled === true
  )
    throw new Error('error.operationCancelled');
  return value;
}
