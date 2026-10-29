import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save, TriangleAlert } from 'lucide-react';
import type { AppCloseDecision, AppCloseRequest } from '../../shared/desktop-lifecycle';
import type { Studio } from '../workspace/useStudio';
import { hasUnsavedChanges, saveBeforeAppClose } from '../workspace/unsavedChanges';
import { recoverCloseDrafts, workspaceCloseGate } from '../workspace/workspaceCloseGate';
import './desktop-lifecycle.css';

/** Native application exit has a separate handshake from closing an editor tab. */
export function DesktopLifecycle({ studio }: { studio: Studio }) {
  const current = useRef(studio);
  current.current = studio;
  const requestRef = useRef<AppCloseRequest | null>(null);
  const [request, setRequest] = useState<AppCloseRequest | null>(null);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const cleanSent = useRef('');
  const committing = useRef('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  const t = studio.t;
  const releaseGate = (id: string) => {
    try {
      workspaceCloseGate.cancel(id);
    } catch (failure) {
      current.current.notify(failure instanceof Error ? failure.message : String(failure), true);
    }
  };
  const report = (next: AppCloseRequest | null) => {
    if (next) workspaceCloseGate.begin(next.id);
    else if (requestRef.current) releaseGate(requestRef.current.id);
    requestRef.current = next;
    setRequest(next);
    setError(next?.error ?? '');
  };

  useEffect(() => {
    if (!studio.isWeb) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges(current.current)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [studio.isWeb]);

  useEffect(() => {
    if (studio.isWeb || typeof window.blode.onAppCloseRequest !== 'function') return;
    let disposed = false;
    const receive = (next: AppCloseRequest) => {
      if (disposed) return;
      if (next.cancelled) {
        if (requestRef.current?.id === next.id) report(null);
        if (next.error) current.current.notify(current.current.t(next.error), true);
        return;
      }
      if (next.phase === 'commit') {
        report(next);
        if (committing.current === next.id) return;
        committing.current = next.id;
        workingRef.current = true;
        setWorking(true);
        void (async () => {
          try {
            const canonical = await window.blode.getState();
            if (disposed || requestRef.current?.id !== next.id) return;
            if (
              next.decision !== 'discard' &&
              (!current.current.state || hasUnsavedChanges(current.current, canonical))
            )
              throw new Error('error.closeNeedsReview');
            if (next.decision === 'discard' && canonical.projectRoot) {
              const recovered = recoverCloseDrafts(
                canonical.projectRoot,
                next.lifecycleId ?? '',
                localStorage,
              );
              workspaceCloseGate.commitDiscard(
                next.id,
                canonical.projectRoot,
                { ...(recovered ?? {}), ...current.current.drafts },
                next.lifecycleId ?? '',
                localStorage,
              );
            }
            await window.blode.desktopCloseReply({ id: next.id, decision: 'committed' });
          } catch (failure) {
            releaseGate(next.id);
            if (!disposed && requestRef.current?.id === next.id) {
              const message = failure instanceof Error ? failure.message : String(failure);
              setError(message);
              await window.blode
                .desktopCloseReply({ id: next.id, decision: 'commitFailed', error: message })
                .catch(() => {});
            }
          } finally {
            if (committing.current === next.id) committing.current = '';
            if (!disposed) {
              workingRef.current = false;
              setWorking(false);
            }
          }
        })();
        return;
      }
      if (requestRef.current?.id === next.id) return;
      report(next);
    };
    const unsubscribe = window.blode.onAppCloseRequest(receive);
    // Replay a close request if the renderer was reloaded while the dialog was open.
    void window.blode
      .desktopLifecycleState()
      .then((state) => {
        if (state.pendingClose) receive(state.pendingClose);
      })
      .catch((failure: unknown) => {
        if (!disposed) current.current.notify(String(failure), true);
      });
    return () => {
      disposed = true;
      unsubscribe();
      if (requestRef.current?.phase === 'commit') workspaceCloseGate.detach(requestRef.current.id);
      else if (requestRef.current) releaseGate(requestRef.current.id);
    };
  }, [studio.isWeb]);

  useEffect(() => {
    if (
      !request ||
      request.phase ||
      !studio.state ||
      request.sharedDirty ||
      request.error ||
      error ||
      hasUnsavedChanges(studio) ||
      cleanSent.current === request.id
    )
      return;
    // The input gate was applied synchronously by receive(), before this clean acknowledgement.
    cleanSent.current = request.id;
    void window.blode.desktopCloseReply({ id: request.id, decision: 'clean' }).catch((failure: unknown) => {
      releaseGate(request.id);
      if (requestRef.current?.id === request.id)
        setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [request, studio.state, studio.drafts, studio.config, error]);

  const needsDecision =
    !!request &&
    request.phase !== 'commit' &&
    (request.sharedDirty || !!request.error || !!error || hasUnsavedChanges(studio));
  useEffect(() => {
    if (!needsDecision || !dialog.current) return;
    const view = dialog.current;
    view.showModal();
    return () => view.close();
  }, [needsDecision, request?.id]);

  const choose = async (decision: AppCloseDecision) => {
    const pending = requestRef.current;
    if (!pending || workingRef.current) return;
    workspaceCloseGate.begin(pending.id);
    workingRef.current = true;
    setWorking(true);
    setError('');
    try {
      if (decision === 'saved') {
        const result = await saveBeforeAppClose(
          () => current.current,
          () => current.current.save(),
          () => window.blode.getState(),
        );
        if (result !== 'saved') {
          releaseGate(pending.id);
          setError(result === 'changed' ? 'error.closeChangedDuringSave' : 'error.closeSaveFailed');
          return;
        }
      }
      if (requestRef.current?.id !== pending.id) return;
      await window.blode.desktopCloseReply({ id: pending.id, decision });
      if (decision === 'cancel' && requestRef.current?.id === pending.id) report(null);
    } catch (failure) {
      releaseGate(pending.id);
      if (requestRef.current?.id === pending.id)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      workingRef.current = false;
      setWorking(false);
    }
  };

  if (!needsDecision || typeof document === 'undefined') return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="app-close-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault();
        if (!workingRef.current) void choose('cancel');
      }}
    >
      <div className="modal-heading">
        <span className="modal-icon warning">
          <TriangleAlert size={18} aria-hidden="true" />
        </span>
        <h2 id={title}>{t('dialog.closeAppTitle')}</h2>
      </div>
      <p id={description}>{t('dialog.closeAppBody')}</p>
      {request?.sharedDirty && <p className="app-close-shared">{t('dialog.closeAppShared')}</p>}
      {error && (
        <p className="app-close-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="modal-actions">
        <button disabled={working} onClick={() => void choose('cancel')}>
          {t('action.cancel')}
        </button>
        <button disabled={working} onClick={() => void choose('discard')}>
          {t('dialog.closeAppDiscard')}
        </button>
        <button
          className="primary"
          autoFocus
          disabled={working || !!studio.busy}
          onClick={() => void choose('saved')}
        >
          <Save size={14} aria-hidden="true" />
          {t(working ? 'dialog.closeFileSaving' : 'dialog.closeAppSave')}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
