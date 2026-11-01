import type { LogEvent } from './contracts';

/** Combine an initial/reconnected snapshot with live events without replay duplicates. */
export function mergeRecentLogs(current: LogEvent[], incoming: LogEvent[]): LogEvent[] {
  const all = [...current, ...incoming].filter(
    (event) => !event.progressOnly && !(event.kind === 'terminal' && !event.message),
  );
  const newer = (a: LogEvent, b: LogEvent) =>
    a.sequence !== undefined && b.sequence !== undefined
      ? a.sequence - b.sequence
      : a.time.localeCompare(b.time);
  const build = all
    .filter((event) => event.message === 'status.buildStarted')
    .sort(newer)
    .at(-1);
  const seen = new Set<number>();
  const ordered = all
    .filter((event) => {
      if (build && event.kind !== 'serial' && newer(event, build) < 0) return false;
      if (event.sequence === undefined) return true;
      if (seen.has(event.sequence)) return false;
      seen.add(event.sequence);
      return true;
    })
    .sort(newer);
  const diagnostics = ordered.filter((event) => event.diagnostic).slice(-1000);
  const ordinary = ordered
    .filter((event) => !event.diagnostic && event.message !== 'status.buildStarted')
    .slice(build ? -499 : -500);
  // Keep the latest build boundary and diagnostics even when verbose tools emit
  // more than one screenful of ordinary output. Reconnects use the same limits.
  return [...ordinary, ...diagnostics, ...(build ? [build] : [])].sort(newer);
}
