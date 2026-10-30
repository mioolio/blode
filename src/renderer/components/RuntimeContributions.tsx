import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, PanelBottom, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { openRuntimeContribution } from '../workspace/runtimeViewActions';
import { runtimeViewKey } from '../../shared/runtime-views';
import type { RuntimeViewContribution } from '../../shared/plugins';
import './runtime-surfaces.css';

export function RuntimeContributions({ studio }: { studio: Studio }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, [open]);
  const [requested, setRequested] = useState<{ pluginId: string; view: RuntimeViewContribution } | null>(
    null,
  );
  const latest = useRef(studio);
  latest.current = studio;
  const plugins = studio.state?.runtimePlugins?.plugins ?? [];
  useEffect(() => {
    const show = () => {
      setRequested(null);
      setOpen(true);
    };
    window.addEventListener('blode:runtime-views', show);
    return () => window.removeEventListener('blode:runtime-views', show);
  }, []);
  useEffect(() => {
    let disposed = false;
    const receive = (event: Event) => {
      const input = (event as CustomEvent<{ pluginId?: unknown; viewId?: unknown }>).detail;
      if (
        !input ||
        typeof input.pluginId !== 'string' ||
        typeof input.viewId !== 'string' ||
        ![input.pluginId, input.viewId].every((value) => /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value))
      )
        return;
      const pluginId = input.pluginId,
        viewId = input.viewId;
      void window.blode
        .runtimePluginViewInfo(pluginId, viewId)
        .then(async (view) => {
          if (disposed) return;
          if (latest.current.isWeb && view.location === 'window') {
            // An SDK request has no browser user gesture. Keep the verified
            // declaration so the next button click can reserve its tab at once.
            setRequested({ pluginId, view });
            setOpen(true);
            return;
          }
          await openRuntimeContribution(pluginId, view);
          if (view.location === 'panel') {
            latest.current.setTab(runtimeViewKey(pluginId, viewId));
            void latest.current.refresh().catch((error) => latest.current.notify(String(error), true));
          }
        })
        .catch((error) => {
          if (!disposed)
            latest.current.notify(
              latest.current.t(error instanceof Error ? error.message : String(error)),
              true,
            );
        });
    };
    window.addEventListener('blode:runtime-view-request', receive);
    return () => {
      disposed = true;
      window.removeEventListener('blode:runtime-view-request', receive);
    };
  }, []);
  const groups = requested
    ? [
        {
          id: requested.pluginId,
          name: plugins.find((plugin) => plugin.id === requested.pluginId)?.name ?? requested.pluginId,
          trust: 'session',
          views: [requested.view],
        },
      ]
    : plugins.map((plugin) => ({ ...plugin, views: plugin.manifest.ui.views ?? [] }));
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="modal runtime-contributions"
      aria-modal="true"
      aria-labelledby="runtime-views-title"
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
    >
      <div className="modal-title">
        <h3 id="runtime-views-title">{studio.t('runtime.views')}</h3>
        <button
          autoFocus
          className="icon-button"
          aria-label={studio.t('action.close')}
          onClick={() => setOpen(false)}
        >
          <X size={17} />
        </button>
      </div>
      {!groups.some((plugin) => plugin.views.length) && <p>{studio.t('runtime.noViews')}</p>}
      {groups
        .filter((plugin) => plugin.views.length)
        .map((plugin) => (
          <div key={plugin.id} className="runtime-contribution-group">
            <strong>{plugin.name}</strong>
            {plugin.views.map((view) => (
              <button
                key={view.id}
                disabled={!!studio.busy}
                onClick={() => {
                  if (plugin.trust === 'required') {
                    window.dispatchEvent(
                      new CustomEvent('blode:runtime-plugin-review', { detail: plugin.id }),
                    );
                    setOpen(false);
                    return;
                  }
                  void studio.perform('runtime.openView', async () => {
                    await openRuntimeContribution(plugin.id, view);
                    setOpen(false);
                  });
                }}
              >
                {view.location === 'window' ? <ExternalLink size={14} /> : <PanelBottom size={14} />}
                <span>{view.label}</span>
                <small>
                  {studio.t(
                    plugin.trust === 'required'
                      ? 'runtime.review'
                      : view.location === 'window'
                        ? 'runtime.window'
                        : 'runtime.panel',
                  )}
                </small>
              </button>
            ))}
          </div>
        ))}
    </dialog>,
    document.body,
  );
}
