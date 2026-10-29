import type { LogEvent } from '../shared/contracts';
import { mergeRecentLogs } from '../shared/recent-logs';

export class RecentLogs {
  private sequence = 0;
  private events: LogEvent[] = [];
  publish(event: LogEvent): LogEvent {
    const next = { ...event, sequence: event.sequence ?? ++this.sequence };
    this.sequence = Math.max(this.sequence, next.sequence);
    if (!next.progressOnly) this.events = mergeRecentLogs(this.events, [next]);
    return next;
  }
  snapshot(): LogEvent[] {
    return structuredClone(this.events);
  }
}
