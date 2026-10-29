import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppState } from '../../shared/contracts';
import { FileCloseQueue, prepareFileClose, type FileClosePrompt, type FileCloseSnapshot } from './fileClose';

interface Options {
  state: AppState | null;
  drafts: Record<string, string>;
  setState: Dispatch<SetStateAction<AppState | null>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  close(path: string): void;
  failed(error: unknown): void;
}

/** Every file-close entry point shares the same single-file transaction and three-way prompt. */
export function useFileTabClose(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [prompt, setPrompt] = useState<FileClosePrompt | null>(null);
  const queue = useRef<FileCloseQueue | undefined>(undefined);
  if (!queue.current)
    queue.current = new FileCloseQueue({
      snapshot(path) {
        const { state, drafts } = latest.current;
        if (!state?.projectRoot) return undefined;
        const file = state.files.find((file) => file.path === path);
        const content = drafts[path] ?? file?.content ?? '';
        return {
          root: state.projectRoot,
          path,
          content,
          dirty: drafts[path] !== undefined && drafts[path] !== file?.content,
        };
      },
      async prepare(snapshot, decision) {
        const handled = await prepareFileClose(snapshot.root, snapshot.path, decision);
        if (decision === 'save' && !handled) await window.blode.saveFile(snapshot.path, snapshot.content);
      },
      close(snapshot: FileCloseSnapshot, decision) {
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
      },
      prompt: setPrompt,
      failed: (error) => latest.current.failed(error),
    });
  const root = options.state?.projectRoot;
  useEffect(() => {
    queue.current!.reset();
    return () => queue.current!.reset();
  }, [root]);
  return {
    closeFilePrompt: prompt,
    chooseFileClose: (decision: 'save' | 'discard' | 'cancel') => queue.current!.choose(decision),
    requestFileClose: (path: string) => queue.current!.request(path),
  };
}
