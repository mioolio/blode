import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppState } from '../../shared/contracts';
import {
  FileCloseQueue,
  prepareFileClose,
  type FileCloseDecision,
  type FileClosePrompt,
  type FileCloseSnapshot,
} from './fileClose';

interface Options {
  state: AppState | null;
  drafts: Record<string, string>;
  setState: Dispatch<SetStateAction<AppState | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  close(path: string): void;
  failed(error: unknown): void;
}
export interface SharedCloseSource {
  content: string;
  dirty: boolean;
}
interface StagedClose {
  requestId: string;
  root: string;
  source?: SharedCloseSource;
  snapshot?: FileCloseSnapshot;
  decision?: FileCloseDecision;
  promise?: Promise<boolean>;
}

/** Every file-close entry point shares the same single-file transaction and three-way prompt. */
export function useFileTabClose(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [prompt, setPrompt] = useState<FileClosePrompt | null>(null);
  const [frozenPaths, setFrozenPaths] = useState<ReadonlySet<string>>(new Set());
  const staged = useRef(new Map<string, StagedClose>());
  const release = (path: string) => {
    staged.current.delete(path);
    setFrozenPaths(new Set(staged.current.keys()));
  };
  const close = (snapshot: FileCloseSnapshot, decision: FileCloseDecision) => {
    const owner = latest.current;
    if (owner.state?.projectRoot !== snapshot.root) return;
    owner.setDrafts((current) => {
      if (current[snapshot.path] !== snapshot.content) return current;
      const next = { ...current };
      delete next[snapshot.path];
      return next;
    });
    if (decision === 'save')
      owner.setState((current) =>
        current?.projectRoot === snapshot.root
          ? {
              ...current,
              files: current.files.map((file) =>
                file.path === snapshot.path ? { ...file, content: snapshot.content } : file,
              ),
            }
          : current,
      );
    owner.close(snapshot.path);
    window.dispatchEvent(
      new CustomEvent('blode:file-closed', { detail: { root: snapshot.root, path: snapshot.path } }),
    );
  };
  const queue = useRef<FileCloseQueue | undefined>(undefined);
  if (!queue.current)
    queue.current = new FileCloseQueue({
      snapshot(path) {
        const { state, drafts } = latest.current;
        if (!state?.projectRoot) return undefined;
        const file = state.files.find((file) => file.path === path);
        const source = staged.current.get(path)?.source;
        const content = drafts[path] ?? source?.content ?? file?.content ?? '';
        return {
          root: state.projectRoot,
          path,
          content,
          dirty: !!source?.dirty || (drafts[path] !== undefined && drafts[path] !== file?.content),
        };
      },
      async prepare(snapshot, decision) {
        const handled = await prepareFileClose(snapshot.root, snapshot.path, decision);
        if (decision === 'save' && !handled)
          await window.blode.saveFile(snapshot.path, snapshot.content, snapshot.root);
      },
      close(snapshot: FileCloseSnapshot, decision) {
        const transaction = staged.current.get(snapshot.path);
        if (transaction?.root === snapshot.root) {
          transaction.snapshot = snapshot;
          transaction.decision = decision;
        } else close(snapshot, decision);
      },
      prompt: setPrompt,
      failed: (error) => latest.current.failed(error),
    });
  const root = options.state?.projectRoot;
  useEffect(() => {
    queue.current!.reset();
    staged.current.clear();
    setFrozenPaths(new Set());
    return () => {
      queue.current!.reset();
      staged.current.clear();
    };
  }, [root]);
  const prepareShared = (path: string, requestId: string, source?: SharedCloseSource): Promise<boolean> => {
    const existing = staged.current.get(path);
    if (existing) return existing.requestId === requestId ? existing.promise! : Promise.resolve(false);
    const root = latest.current.state?.projectRoot;
    if (!root) return Promise.resolve(false);
    const transaction: StagedClose = { requestId, root, source };
    staged.current.set(path, transaction);
    setFrozenPaths(new Set(staged.current.keys()));
    transaction.promise = queue.current!.request(path).then((ready) => {
      if (!ready && staged.current.get(path) === transaction) release(path);
      return ready;
    });
    return transaction.promise;
  };
  return {
    closeFilePrompt: prompt,
    chooseFileClose: (decision: 'save' | 'discard' | 'cancel') => queue.current!.choose(decision),
    requestFileClose: (path: string) => queue.current!.request(path),
    frozenPaths,
    prepareShared,
    preparedShared(path: string, requestId: string) {
      const transaction = staged.current.get(path);
      return transaction?.requestId === requestId && transaction.snapshot && transaction.decision
        ? { content: transaction.snapshot.content, decision: transaction.decision }
        : undefined;
    },
    abortShared(path: string, requestId: string) {
      if (staged.current.get(path)?.requestId !== requestId) return;
      queue.current!.cancel(path);
      release(path);
    },
    async commitShared(path: string, requestId: string): Promise<boolean> {
      // A replayed close still needs this client's unsaved-file decision.
      if (!staged.current.has(path) && !(await prepareShared(path, requestId))) return false;
      const transaction = staged.current.get(path);
      if (transaction?.requestId !== requestId || !transaction.snapshot || !transaction.decision)
        return false;
      const current = latest.current;
      const content =
        current.drafts[path] ??
        transaction.source?.content ??
        current.state?.files.find((file) => file.path === path)?.content ??
        '';
      if (current.state?.projectRoot !== transaction.root || content !== transaction.snapshot.content) {
        release(path);
        current.failed(new Error('error.tabCloseChanged'));
        return false;
      }
      close(transaction.snapshot, transaction.decision);
      release(path);
      return true;
    },
  };
}
