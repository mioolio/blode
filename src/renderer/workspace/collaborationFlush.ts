const flushers = new Set<() => Promise<Record<string, string>>>();

export function registerCollaborationFlush(flush: () => Promise<Record<string, string>>): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/** Saves and builds must not race optimistic edits that have not reached the shared revision. */
export async function flushCollaboration(): Promise<Record<string, string>> {
  return Object.assign({}, ...(await Promise.all([...flushers].map((flush) => flush()))));
}
