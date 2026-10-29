/** Shared suggestions never become local opens until the user explicitly selects one. */
export function visibleFilePaths(
  local: readonly string[],
  remote: readonly string[],
  dismissed: ReadonlySet<string>,
): string[] {
  return [...new Set([...local, ...remote.filter((path) => !dismissed.has(path))])];
}

/** A dismissed suggestion stays closed until its remote open episode ends or it is opened locally. */
export function reconcileDismissedTabs(
  dismissed: ReadonlySet<string>,
  local: readonly string[],
  remote: readonly string[],
): ReadonlySet<string> {
  const available = new Set(remote),
    owned = new Set(local);
  const retained = [...dismissed].filter((path) => available.has(path) && !owned.has(path));
  return retained.length === dismissed.size ? dismissed : new Set(retained);
}

export interface FileClosedEvent {
  root: string;
  path: string;
}
