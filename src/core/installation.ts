import { randomUUID } from 'node:crypto';
import type { InstallationProgress, InstallationState, LogEvent } from '../shared/contracts';

/** Keeps the current install visible across preference tabs and renderer reloads. */
export class InstallationTracker {
  private current?: InstallationState;

  constructor(private readonly publish: (event: LogEvent) => void) {}

  snapshot(): InstallationState | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  capture(event: LogEvent): LogEvent {
    if (!this.current || this.current.status !== 'running' || event.kind === 'serial') return event;
    return this.decorate(event);
  }

  private decorate(event: LogEvent): LogEvent {
    const current = this.current!;
    current.updatedAt = event.time;
    if (!event.progressOnly)
      current.logs = [...current.logs.slice(-299), { ...event, message: event.message.slice(0, 8192) }];
    const { logs: _logs, ...installation } = current;
    return { ...event, installation };
  }

  progress = (progress: InstallationProgress): void => {
    if (!this.current || this.current.status !== 'running') return;
    const changed = this.current.tool !== progress.tool || this.current.phase !== progress.phase;
    this.current = {
      ...this.current,
      ...progress,
      receivedBytes: progress.phase === 'downloading' ? progress.receivedBytes : undefined,
      totalBytes: progress.phase === 'downloading' ? progress.totalBytes : undefined,
    };
    this.publish(
      this.decorate({
        kind: 'status',
        level: 'info',
        message: {
          starting: 'status.installStarting',
          downloading: 'status.installDownloading',
          verifying: 'status.installVerifying',
          extracting: 'status.installExtracting',
          installing: 'status.installInstalling',
          completed: 'status.installCompleted',
          failed: 'status.installFailed',
        }[progress.phase],
        time: new Date().toISOString(),
        progressOnly: !changed,
      }),
    );
  };

  async run<T>(tool: string, action: () => Promise<T>): Promise<T> {
    if (this.current?.status === 'running') throw new Error('error.busy');
    this.current = {
      id: randomUUID(),
      tool,
      phase: 'starting',
      status: 'running',
      updatedAt: new Date().toISOString(),
      logs: [],
    };
    this.publish(
      this.decorate({
        kind: 'status',
        level: 'info',
        message: 'status.installStarting',
        time: this.current.updatedAt,
      }),
    );
    try {
      const value = await action();
      this.finish('completed', 'status.installCompleted');
      return value;
    } catch (error) {
      this.finish('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private finish(status: 'completed' | 'failed', message: string): void {
    this.current = {
      ...this.current!,
      status,
      phase: status,
      receivedBytes: undefined,
      totalBytes: undefined,
    };
    this.publish(
      this.decorate({
        kind: 'status',
        level: status === 'failed' ? 'error' : 'success',
        message,
        time: new Date().toISOString(),
      }),
    );
  }
}
