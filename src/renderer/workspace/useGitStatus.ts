import { useEffect, useState } from 'react';
import type { GitApi, GitStatus } from '../../shared/git';

const cache = new Map<string, GitStatus>();
const listeners = new Map<string, Set<() => void>>();
const pending = new Map<string, Promise<void>>();
const api = () => window.blode as typeof window.blode & Partial<GitApi>;
export function cacheGitStatus(state: GitStatus) {
  cache.set(state.projectRoot, state);
  for (const listener of listeners.get(state.projectRoot) ?? []) listener();
  while (cache.size > 12) cache.delete(cache.keys().next().value!);
}
export function refreshGitStatus(root: string): Promise<void> {
  if (!root || !api().gitStatus) return Promise.resolve();
  if (pending.has(root)) return pending.get(root)!;
  const task = api().gitStatus!()
    .then((state) => {
      if (state.projectRoot === root) cacheGitStatus(state);
    })
    .finally(() => pending.delete(root));
  pending.set(root, task);
  return task;
}
/** Tree and Git panel share one status request; updates follow actual workspace events. */
export function useGitStatus(root: string) {
  const [state, setState] = useState<GitStatus | undefined>(() => cache.get(root));
  const [error, setError] = useState('');
  useEffect(() => {
    setState(cache.get(root));
    setError('');
    if (!root) return;
    const update = () => {
      setState(cache.get(root));
      setError('');
    };
    const callbacks = listeners.get(root) ?? new Set();
    listeners.set(root, callbacks);
    callbacks.add(update);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void refreshGitStatus(root).catch((error) =>
            setError(error instanceof Error ? error.message : String(error)),
          ),
        120,
      );
    };
    void refreshGitStatus(root).catch((error) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
    const unsubscribe = window.blode.onEvent((event) => {
      if (
        ['status.gitChanged', 'status.workspaceChanged', 'status.fileSaved', 'status.projectOpened'].includes(
          event.message,
        )
      )
        refresh();
    });
    return () => {
      clearTimeout(timer);
      callbacks.delete(update);
      if (!callbacks.size) listeners.delete(root);
      unsubscribe();
    };
  }, [root]);
  return { state, error, refresh: () => refreshGitStatus(root) };
}
