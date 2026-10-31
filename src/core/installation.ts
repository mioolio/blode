import { randomUUID } from 'node:crypto';
import type { InstallationProgress, InstallationState, LogEvent } from '../shared/contracts';
import { toolPhaseKey } from '../shared/tool-operation';

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
    const last = current.logs.at(-1);
    if (
      event.kind === 'status' &&
      last?.message === event.message &&
      last.level === event.level &&
      last.kind === event.kind
    )
      event = { ...event, progressOnly: true };
    if (!event.progressOnly)
      current.logs = [...current.logs.slice(-299), { ...event, message: event.message.slice(0, 8192) }];
    const { logs: _logs, ...installation } = current;
    return { ...event, installation };
  }

  progress = (progress: InstallationProgress): void => {
    if (!this.current || this.current.status !== 'running') return;
    const changed =
      this.current.phase !== progress.phase ||
      (!!progress.operation && progress.operation !== this.current.operation);
    this.current = {
      ...this.current,
      ...progress,
      operation: progress.operation ?? this.current.operation ?? 'install',
      percent: progress.percent,
      processedFiles: progress.processedFiles,
      totalFiles: progress.totalFiles,
      receivedBytes: progress.phase === 'downloading' ? progress.receivedBytes : undefined,
      totalBytes: progress.phase === 'downloading' ? progress.totalBytes : undefined,
    };
    this.publish(
      this.decorate({
        kind: 'status',
        level: progress.phase === 'completed' ? 'success' : progress.phase === 'failed' ? 'error' : 'info',
        message: toolPhaseKey(progress.phase, this.current.operation),
        time: new Date().toISOString(),
        progressOnly: !changed,
      }),
    );
  };

  async run<T>(
    tool: string,
    action: () => Promise<T>,
    operation: InstallationProgress['operation'] = 'install',
  ): Promise<T> {
    if (this.current?.status === 'running') throw new Error('error.busy');
    this.current = {
      id: randomUUID(),
      tool,
      operation,
      phase: 'starting',
      status: 'running',
      updatedAt: new Date().toISOString(),
      logs: [],
    };
    this.publish(
      this.decorate({
        kind: 'status',
        level: 'info',
        message: toolPhaseKey('starting', operation),
        time: this.current.updatedAt,
      }),
    );
    try {
      const value = await action();
      this.finish('completed', toolPhaseKey('completed', this.current?.operation));
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
