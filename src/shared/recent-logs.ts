import type { LogEvent } from './contracts';

/** Combine an initial/reconnected snapshot with live events without replay duplicates. */
export function mergeRecentLogs(current: LogEvent[], incoming: LogEvent[]): LogEvent[] {
  const all = [...current, ...incoming].filter((event) => !event.progressOnly);
  const newer = (a: LogEvent, b: LogEvent) =>
    a.sequence !== undefined && b.sequence !== undefined
      ? a.sequence - b.sequence
      : a.time.localeCompare(b.time);
  const build = all
    .filter((event) => event.message === 'status.buildStarted')
    .sort(newer)
    .at(-1);
  const seen = new Set<number>();
  return all
    .filter((event) => {
      if (build && event.kind !== 'serial' && newer(event, build) < 0) return false;
      if (event.sequence === undefined) return true;
      if (seen.has(event.sequence)) return false;
      seen.add(event.sequence);
      return true;
    })
    .sort(newer)
    .slice(-500);
}
