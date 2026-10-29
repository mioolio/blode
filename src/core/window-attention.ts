export interface WindowAttention {
  visible: boolean;
  focused: boolean;
  epoch?: number;
}

/** Keep the private window state available when React subscribes after the first native event. */
export function createWindowAttentionChannel(options: {
  listen(listener: (value: WindowAttention) => void): () => void;
  snapshot(): Promise<WindowAttention>;
}) {
  let current: WindowAttention | undefined;
  let revision = 0;
  let disposed = false;
  let pending = false;
  const listeners = new Set<(value: WindowAttention) => void>();
  const publish = (value: WindowAttention, requestedAt?: number) => {
    if (disposed) return;
    if (current?.epoch !== undefined && (value.epoch === undefined || value.epoch < current.epoch)) return;
    if (requestedAt !== undefined && requestedAt !== revision && value.epoch === undefined) return;
    revision++;
    current = value;
    for (const listener of listeners) listener(value);
  };
  const stop = options.listen((value) => publish(value));
  const request = () => {
    if (current || pending || disposed) return;
    pending = true;
    const requestedAt = revision;
    void options.snapshot().then(
      (value) => {
        pending = false;
        publish(value, requestedAt);
      },
      () => {
        pending = false;
      },
    );
  };
  return {
    subscribe(listener: (value: WindowAttention) => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      if (current) listener(current);
      request();
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      stop();
      listeners.clear();
    },
  };
}
