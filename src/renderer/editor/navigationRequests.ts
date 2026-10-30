import type { LanguageNavigationRequest, SourceLocation } from '../../shared/language';

export interface NavigationCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?: (listener: () => void) => { dispose(): void };
}
interface Consumer {
  cancel(): void;
  finish(value?: SourceLocation[], error?: unknown): void;
}
interface Pending {
  id: string;
  started: boolean;
  generation: number;
  request: LanguageNavigationRequest;
  consumers: Set<Consumer>;
}

/** One host lookup per live query; each Monaco consumer retains its own cancellation. */
export class NavigationRequests {
  private pending = new Map<string, Pending>();
  private cached = new Map<string, { expires: number; value: SourceLocation[] }>();
  private generation = 0;
  constructor(
    private readonly options: {
      invoke(request: LanguageNavigationRequest): Promise<SourceLocation[]>;
      cancel(request: { expectedProjectRoot: string; requestId: string }): Promise<void>;
      now?: () => number;
    },
  ) {}
  reset(): void {
    this.generation++;
    for (const job of this.pending.values()) {
      for (const consumer of [...job.consumers]) consumer.cancel();
    }
    this.pending.clear();
    this.cached.clear();
  }
  query(
    request: LanguageNavigationRequest,
    token: NavigationCancellation,
    current: () => boolean,
  ): Promise<SourceLocation[]> {
    if (token.isCancellationRequested || !current()) return Promise.resolve([]);
    const key = JSON.stringify(request),
      now = this.options.now?.() ?? Date.now(),
      cached = this.cached.get(key);
    if (cached && cached.expires > now)
      return Promise.resolve().then(() => (token.isCancellationRequested || !current() ? [] : cached.value));
    if (cached) this.cached.delete(key);
    let job = this.pending.get(key);
    if (!job) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      job = { id, started: false, generation: this.generation, request, consumers: new Set() };
      this.pending.set(key, job);
      const active = job;
      queueMicrotask(() => {
        if (this.pending.get(key) !== active || !active.consumers.size) return;
        active.started = true;
        void Promise.resolve()
          .then(() =>
            this.pending.get(key) === active ? this.options.invoke({ ...request, requestId: id }) : [],
          )
          .then(
            (value) => {
              if (this.pending.get(key) !== active || active.generation !== this.generation) return;
              // SDK coordinates must be revalidated alongside a refreshed source snapshot.
              if (value.length <= 256 && !value.some((target) => target.externalId)) {
                this.cached.set(key, {
                  value,
                  expires: (this.options.now?.() ?? Date.now()) + (value.length ? 3000 : 500),
                });
                while (this.cached.size > 64) this.cached.delete(this.cached.keys().next().value!);
              }
              this.pending.delete(key);
              for (const consumer of [...active.consumers]) consumer.finish(value);
            },
            (error) => {
              if (this.pending.get(key) !== active) return;
              this.pending.delete(key);
              for (const consumer of [...active.consumers]) consumer.finish(undefined, error);
            },
          );
      });
    }
    const active = job;
    return new Promise((resolve, reject) => {
      let done = false,
        subscription: { dispose(): void } | undefined;
      const finish = (value: SourceLocation[] = [], error?: unknown) => {
        if (done) return;
        done = true;
        subscription?.dispose();
        active.consumers.delete(consumer);
        if (
          token.isCancellationRequested ||
          !current() ||
          (error instanceof Error && error.message === 'error.operationCancelled')
        )
          resolve([]);
        else if (error) reject(error);
        else resolve(value);
      };
      const consumer: Consumer = {
        finish,
        cancel: () => {
          finish();
          if (!active.consumers.size && this.pending.get(key) === active) {
            this.pending.delete(key);
            if (active.started)
              void Promise.resolve()
                .then(() =>
                  this.options.cancel({
                    expectedProjectRoot: request.expectedProjectRoot,
                    requestId: active.id,
                  }),
                )
                .catch(() => {});
          }
        },
      };
      active.consumers.add(consumer);
      subscription = token.onCancellationRequested?.(consumer.cancel);
      if (done) subscription?.dispose();
      if (token.isCancellationRequested || !current()) consumer.cancel();
    });
  }
}

/** A task boundary lets the context menu paint and cancellation events run. */
export const yieldNavigation = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
