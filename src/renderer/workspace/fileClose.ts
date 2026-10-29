export type FileCloseDecision = 'save' | 'discard' | 'release';
export type FileCloseHandler = (root: string, path: string, decision: FileCloseDecision) => Promise<boolean>;

const handlers = new Set<FileCloseHandler>();

/** A shared editor can prepare one file without flushing or saving unrelated tabs. */
export function registerFileCloseHandler(handler: FileCloseHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export async function prepareFileClose(root: string, path: string, decision: FileCloseDecision) {
  for (const handler of [...handlers]) if (await handler(root, path, decision)) return true;
  return false;
}

export interface FileCloseSnapshot {
  root: string;
  path: string;
  content: string;
  dirty: boolean;
}
export interface FileClosePrompt {
  root: string;
  path: string;
  busy: boolean;
  error?: string;
}
interface PendingClose {
  root: string;
  path: string;
  promise: Promise<boolean>;
  resolve(value: boolean): void;
}
interface CloseHost {
  snapshot(path: string): FileCloseSnapshot | undefined;
  prepare(snapshot: FileCloseSnapshot, decision: FileCloseDecision): Promise<void>;
  close(snapshot: FileCloseSnapshot, decision: FileCloseDecision): void;
  prompt(value: FileClosePrompt | null): void;
  failed(error: unknown): void;
}

/** Serializes close intents so repeat clicks and multiple tabs cannot replace an unanswered choice. */
export class FileCloseQueue {
  private pending: PendingClose[] = [];
  private current?: PendingClose;
  private working = false;
  private shown = false;
  constructor(private readonly host: CloseHost) {}

  request(path: string): Promise<boolean> {
    const snapshot = this.host.snapshot(path);
    if (!snapshot) return Promise.resolve(false);
    const existing = [this.current, ...this.pending].find(
      (item) => item?.root === snapshot.root && item.path === path,
    );
    if (existing) return existing.promise;
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    this.pending.push({ root: snapshot.root, path, promise, resolve });
    this.advance();
    return promise;
  }
  private advance() {
    if (this.current) return;
    this.current = this.pending.shift();
    if (!this.current) return;
    const snapshot = this.host.snapshot(this.current.path);
    if (!snapshot || snapshot.root !== this.current.root) {
      this.finish(false);
      return;
    }
    if (snapshot.dirty) this.show();
    else void this.apply('release');
  }
  private show(error?: string) {
    if (!this.current) return;
    this.shown = true;
    this.host.prompt({
      root: this.current.root,
      path: this.current.path,
      busy: this.working,
      ...(error ? { error } : {}),
    });
  }
  private finish(value: boolean) {
    const done = this.current;
    this.current = undefined;
    this.working = false;
    this.shown = false;
    this.host.prompt(null);
    done?.resolve(value);
    this.advance();
  }
  choose(decision: 'save' | 'discard' | 'cancel'): Promise<void> {
    if (!this.current || this.working) return Promise.resolve();
    if (decision === 'cancel') {
      this.finish(false);
      return Promise.resolve();
    }
    return this.apply(decision);
  }
  private async apply(decision: FileCloseDecision) {
    const pending = this.current;
    if (!pending) return;
    const snapshot = this.host.snapshot(pending.path);
    if (!snapshot || snapshot.root !== pending.root) {
      this.finish(false);
      return;
    }
    this.working = true;
    if (this.shown) this.show();
    try {
      await this.host.prepare(snapshot, decision);
      if (this.current !== pending) return;
      const current = this.host.snapshot(pending.path);
      if (!current || current.root !== pending.root) {
        this.finish(false);
        return;
      }
      this.working = false;
      // A save/flush can be slow. Never erase keystrokes or a new remote edit that arrived meanwhile.
      if (current.content !== snapshot.content || (decision === 'release' && current.dirty)) {
        this.show('dialog.closeFileChanged');
        return;
      }
      this.host.close(snapshot, decision);
      this.finish(true);
    } catch (error) {
      if (this.current !== pending) return;
      this.working = false;
      this.host.failed(error);
      if (this.shown) this.show(error instanceof Error ? error.message : String(error));
      else this.finish(false);
    }
  }
  reset() {
    const pending = [this.current, ...this.pending];
    this.current = undefined;
    this.pending = [];
    this.working = false;
    this.shown = false;
    this.host.prompt(null);
    for (const item of pending) item?.resolve(false);
  }
}
