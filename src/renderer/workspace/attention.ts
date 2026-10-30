export interface AttentionSnapshot {
  active: boolean;
  revision: number;
  nativeEpoch?: number;
}

/** Sources register independently; a window is attentive only while every source is available. */
export class AttentionRegistry {
  private sources = new Map<string, boolean>();
  private listeners = new Set<(value: AttentionSnapshot) => void>();
  private revision = 0;
  private closed = false;
  touch() {
    if (this.closed) return;
    this.revision++;
    for (const listener of this.listeners) listener(this.snapshot());
  }
  snapshot(): AttentionSnapshot {
    return { active: !this.closed && [...this.sources.values()].every(Boolean), revision: this.revision };
  }
  register(name: string, initial: boolean) {
    if (this.closed || this.sources.has(name)) throw new Error('Duplicate or closed attention source');
    this.sources.set(name, initial);
    const publish = () => {
      this.revision++;
      const value = this.snapshot();
      for (const listener of this.listeners) listener(value);
    };
    publish();
    return {
      update: (available: boolean) => {
        if (this.closed || !this.sources.has(name) || this.sources.get(name) === available) return;
        this.sources.set(name, available);
        publish();
      },
      dispose: () => {
        if (!this.closed && this.sources.delete(name)) publish();
      },
    };
  }
  subscribe(listener: (value: AttentionSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close() {
    this.closed = true;
    this.sources.clear();
    this.listeners.clear();
  }
}

interface PageDocument extends EventTarget {
  visibilityState: string;
  hasFocus(): boolean;
}
export interface NativeAttention {
  visible: boolean;
  focused: boolean;
  epoch?: number;
}

/** One lifecycle adapter serves Electron windows and browser pages, including bfcache restores. */
export function observePageAttention(
  page: EventTarget,
  document: PageDocument,
  network: { onLine?: boolean },
  native?: (listener: (value: NativeAttention) => void) => () => void,
) {
  const registry = new AttentionRegistry();
  let nativeEpoch: number | undefined;
  const visibility = registry.register('visibility', document.visibilityState === 'visible');
  const focus = registry.register('focus', document.hasFocus());
  const online = registry.register('network', network.onLine !== false);
  const lifecycle = registry.register('page', true);
  const nativeWindow = registry.register('native', !native);
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, name: string, action: () => void) => {
    target.addEventListener(name, action);
    listeners.push(() => target.removeEventListener(name, action));
  };
  const sample = () => {
    visibility.update(document.visibilityState === 'visible');
    focus.update(document.hasFocus());
    online.update(network.onLine !== false);
  };
  listen(document, 'visibilitychange', sample);
  listen(page, 'focus', sample);
  listen(page, 'blur', () => focus.update(false));
  listen(page, 'online', sample);
  listen(page, 'offline', () => online.update(false));
  listen(page, 'pagehide', () => lifecycle.update(false));
  listen(page, 'pageshow', () => {
    sample();
    lifecycle.update(true);
  });
  const unsubscribeNative = native?.((value) => {
    if (value.epoch !== undefined && nativeEpoch !== undefined && value.epoch < nativeEpoch) return;
    const changed = nativeEpoch !== value.epoch;
    nativeEpoch = value.epoch;
    const revision = registry.snapshot().revision;
    nativeWindow.update(value.visible && value.focused);
    if (changed && revision === registry.snapshot().revision) registry.touch();
  });
  return {
    registerSource: (name: string, initial: boolean) => registry.register(name, initial),
    snapshot: () => ({ ...registry.snapshot(), nativeEpoch }),
    subscribe: (listener: (value: AttentionSnapshot) => void) =>
      registry.subscribe((value) => listener({ ...value, nativeEpoch })),
    close: () => {
      registry.close();
      listeners.forEach((dispose) => dispose());
      unsubscribeNative?.();
    },
  };
}
