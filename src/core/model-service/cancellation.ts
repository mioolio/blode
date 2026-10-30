/** Stop awaiting promptly; callers still guard queued mutations with the original signal. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  const error = () =>
    new Error(
      signal?.reason instanceof Error && signal.reason.name === 'TimeoutError'
        ? 'error.aiTimeout'
        : 'error.aiRequestCancelled',
    );
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(error());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(error());
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (reason) => {
        signal.removeEventListener('abort', abort);
        reject(reason);
      },
    );
  });
}
