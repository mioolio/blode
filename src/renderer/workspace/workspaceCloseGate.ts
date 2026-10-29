export interface CloseDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CloseRecovery {
  version: 1;
  requestId: string;
  lifecycleId: string;
  drafts: Record<string, string>;
}

export const closeRecoveryKey = (root: string) => `blode.close-recovery:${root}`;
const draftKey = (root: string) => `blode.drafts:${root}`;
const storageOf = (storage?: CloseDraftStorage) => storage ?? globalThis.localStorage;
function draftObject(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((content) => typeof content === 'string')
  );
}
function readDrafts(storage: CloseDraftStorage, root: string): Record<string, string> {
  const text = storage.getItem(draftKey(root));
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return draftObject(value) ? value : {};
  } catch {
    return {};
  }
}

/** Restore an interrupted close only within the same native application run. */
export function recoverCloseDrafts(
  root: string,
  lifecycleId: string,
  storage?: CloseDraftStorage,
): Record<string, string> | undefined {
  const target = storageOf(storage);
  const text = target.getItem(closeRecoveryKey(root));
  if (!text) return;
  let record: CloseRecovery;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return;
    const parsed = value as Partial<CloseRecovery>;
    if (
      parsed.version !== 1 ||
      typeof parsed.requestId !== 'string' ||
      typeof parsed.lifecycleId !== 'string' ||
      !draftObject(parsed.drafts)
    )
      return;
    record = parsed as CloseRecovery;
  } catch {
    return;
  }
  if (record.lifecycleId !== lifecycleId) {
    target.removeItem(closeRecoveryKey(root));
    return;
  }
  // If cancellation unlocked a renderer whose storage was temporarily full,
  // later persisted user edits take precedence over its retained backup.
  const drafts = { ...record.drafts, ...readDrafts(target, root) };
  target.setItem(draftKey(root), JSON.stringify(drafts));
  target.removeItem(closeRecoveryKey(root));
  return drafts;
}

/** Freeze input synchronously; a modal appended afterwards remains interactive. */
function freezeWorkspace(): () => void {
  if (typeof document === 'undefined' || !document.body) return () => {};
  const body = document.body;
  const inert = new Map<Element, string | null>();
  const restore = (element: Element) => {
    if (!inert.has(element)) return;
    const previous = inert.get(element)!;
    if (previous === null) element.removeAttribute('inert');
    else element.setAttribute('inert', previous);
    inert.delete(element);
  };
  const apply = (element: Element) => {
    if (element.matches('.app-close-dialog')) {
      restore(element);
      return;
    }
    if (element.querySelector('.app-close-dialog')) {
      restore(element);
      for (const child of Array.from(element.children)) apply(child);
      return;
    }
    if (!inert.has(element)) inert.set(element, element.getAttribute('inert'));
    element.setAttribute('inert', '');
  };
  const scan = () => {
    for (const child of Array.from(body.children)) apply(child);
  };
  const block = (event: Event) => {
    if (
      event.composedPath().some((node) => {
        const element = node as Partial<Element>;
        return typeof element.closest === 'function' && !!element.closest('.app-close-dialog');
      })
    )
      return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = [
    'beforeinput',
    'input',
    'keydown',
    'keypress',
    'paste',
    'cut',
    'drop',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'contextmenu',
  ];
  scan();
  for (const name of events) document.addEventListener(name, block, true);
  const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(scan);
  observer?.observe(body, { childList: true, subtree: true });
  return () => {
    observer?.disconnect();
    for (const name of events) document.removeEventListener(name, block, true);
    for (const element of [...inert.keys()]) restore(element);
  };
}

/** A renderer gate complements the host's exclusive collaboration shutdown lock. */
export class WorkspaceCloseGate {
  private active?: { id: string; release?: () => void };
  private recovery?: CloseRecovery & { root: string; storage: CloseDraftStorage; committed: boolean };
  constructor(private readonly options: { freeze?: () => () => void } = {}) {}
  begin(id: string): void {
    if (this.active?.id === id) {
      this.active.release ??= (this.options.freeze ?? freezeWorkspace)();
      return;
    }
    if (this.active) {
      try {
        this.cancel(this.active.id);
      } catch {
        /* Retained durable recovery is retried independently of a newer request. */
      }
    }
    this.active = { id, release: (this.options.freeze ?? freezeWorkspace)() };
  }
  isFrozen(): boolean {
    return !!this.active;
  }
  canApplySharedDrafts(): boolean {
    return !this.recovery?.committed;
  }
  canPersistDrafts(root: string): boolean {
    return !(this.recovery?.committed && this.recovery.root === root);
  }
  /** React cleanup is not a cancelled exit; keep its discard decision durable across hot reloads. */
  detach(id: string): void {
    if (this.active?.id !== id) return;
    const release = this.active.release;
    this.active.release = undefined;
    release?.();
  }
  commitDiscard(
    id: string,
    root: string,
    drafts: Record<string, string>,
    lifecycleId: string,
    storage?: CloseDraftStorage,
  ): void {
    if (!this.active || this.active.id !== id) throw new Error('error.closeRequestExpired');
    if (this.recovery && this.recovery.root !== root) throw new Error('rpc.invalidParams');
    const target = storageOf(storage);
    const captured = { ...(this.recovery?.drafts ?? {}), ...readDrafts(target, root), ...drafts };
    const record: CloseRecovery = { version: 1, requestId: id, lifecycleId, drafts: captured };
    // Preserve the normal draft key if the durable backup cannot be written.
    target.setItem(closeRecoveryKey(root), JSON.stringify(record));
    this.recovery = { ...record, root, storage: target, committed: false };
    target.removeItem(draftKey(root));
    this.recovery.committed = true;
  }
  cancel(id: string): void {
    if (!this.active || this.active.id !== id) return;
    const active = this.active;
    try {
      if (this.recovery) {
        const { root, drafts, storage } = this.recovery;
        storage.setItem(draftKey(root), JSON.stringify(drafts));
        storage.removeItem(closeRecoveryKey(root));
      }
    } finally {
      // Live React drafts were never discarded. Storage failure must not leave
      // the application permanently inert; its backup remains recoverable.
      this.recovery = undefined;
      this.active = undefined;
      active.release?.();
    }
  }
}

export const workspaceCloseGate = new WorkspaceCloseGate();
