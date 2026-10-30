import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { RuntimePluginInfo } from '../../shared/plugins';
import type { Studio } from '../workspace/useStudio';
import { useI18n } from '../i18n';
import './runtime-plugin.css';

export function RuntimePluginTrustDialog({ studio, id }: { studio?: Studio; id?: string }) {
  const { t } = useI18n();
  const [plugin, setPlugin] = useState<RuntimePluginInfo | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const modal = useRef<HTMLElement>(null);
  const prompted = useRef(new Set<string>());
  const current = useRef(studio);
  current.current = studio;
  const show = (next: RuntimePluginInfo) => {
    prompted.current.add(`${next.id}:${next.fingerprint}`);
    setPermanent(false);
    setPlugin(next);
  };
  useEffect(() => {
    let disposed = false;
    const inspect = (plugins: RuntimePluginInfo[]) => {
      if (disposed) return;
      const next = plugins.find((item) => item.id === (id ?? studio?.config?.boardId));
      if (next?.trust !== 'required' && next) prompted.current.delete(`${next.id}:${next.fingerprint}`);
      if (next?.trust === 'required' && !prompted.current.has(`${next.id}:${next.fingerprint}`)) show(next);
    };
    if (studio?.state?.runtimePlugins) inspect(studio.state.runtimePlugins.plugins);
    else if (id)
      void window.blode
        .runtimePluginsState()
        .then((value) => inspect(value.plugins))
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [id, studio?.config?.boardId, studio?.state?.runtimePlugins]);
  useEffect(() => {
    const open = (event: Event) => {
      const selectedId = (event as CustomEvent<string>).detail ?? id ?? current.current?.config?.boardId;
      const next = current.current?.state?.runtimePlugins?.plugins.find((item) => item.id === selectedId);
      if (next) show(next);
      else if (selectedId)
        void window.blode
          .runtimePluginsState()
          .then((value) => {
            const found = value.plugins.find((item) => item.id === selectedId);
            if (found) show(found);
          })
          .catch((value) => setError(String(value)));
    };
    window.addEventListener('blode:runtime-plugin-review', open);
    return () => window.removeEventListener('blode:runtime-plugin-review', open);
  }, [id]);
  const busy = pending || !!studio?.busy;
  useEffect(() => {
    if (!plugin) return;
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        setPlugin(null);
      }
      if (event.key === 'Tab') {
        const nodes = [
          ...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ??
            []),
        ];
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (previous?.isConnected) previous.focus();
    };
  }, [!!plugin, busy]);
  if (!plugin) return null;
  return (
    <div className="modal-backdrop workspace-dialog-backdrop">
      <section
        ref={modal}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="runtime-trust-title"
        aria-describedby="runtime-trust-warning"
        className="modal runtime-trust-modal"
      >
        <div className="modal-title">
          <h3 id="runtime-trust-title">
            <AlertTriangle size={19} />
            {t('runtime.trustTitle')}
          </h3>
          <button
            className="icon-button"
            aria-label={t('action.close')}
            disabled={!!busy}
            onClick={() => setPlugin(null)}
          >
            <X size={17} />
          </button>
        </div>
        <p id="runtime-trust-warning" className="runtime-trust-warning">
          {t('runtime.trustWarning')}
        </p>
        {error && <p role="alert">{error}</p>}
        {plugin.restartRequired && <p role="alert">{t('error.runtimePluginRestartRequired')}</p>}
        <dl className="runtime-trust-facts">
          <dt>{t('device.board')}</dt>
          <dd>
            {plugin.name} · {plugin.manifest.version}
          </dd>
          <dt>{t('runtime.package')}</dt>
          <dd>{plugin.directory}</dd>
          <dt>{t('runtime.coverage')}</dt>
          <dd>{plugin.manifest.support.chips.join(', ')}</dd>
          <dt>{t('runtime.entry')}</dt>
          <dd>{plugin.manifest.runtime}</dd>
          <dt>{t('runtime.compiler')}</dt>
          <dd>
            {plugin.manifest.compiler.mode}
            {plugin.manifest.compiler.defaultTool && ` · ${plugin.manifest.compiler.defaultTool.id}`}
          </dd>
          <dt>{t('runtime.fingerprint')}</dt>
          <dd className="runtime-hash">{plugin.fingerprint}</dd>
        </dl>
        <label className="runtime-trust-remember">
          <input
            type="checkbox"
            checked={permanent}
            onChange={(event) => setPermanent(event.target.checked)}
            disabled={!!busy}
          />
          {t('runtime.remember')}
        </label>
        <div className="modal-actions">
          <button disabled={!!busy} onClick={() => setPlugin(null)}>
            {t('action.cancel')}
          </button>
          <button
            className="primary"
            disabled={!!busy || plugin.restartRequired}
            onClick={() =>
              void (async () => {
                setPending(true);
                setError('');
                try {
                  await window.blode.runtimePluginTrust({
                    id: plugin.id,
                    fingerprint: plugin.fingerprint,
                    confirm: true,
                    permanent,
                  });
                  await studio?.refresh();
                  prompted.current.delete(`${plugin.id}:${plugin.fingerprint}`);
                  setPlugin(null);
                  window.dispatchEvent(
                    new CustomEvent('blode:runtime-plugin-trusted', { detail: plugin.id }),
                  );
                } catch (value) {
                  setError(t(value instanceof Error ? value.message : String(value)));
                } finally {
                  setPending(false);
                }
              })()
            }
          >
            {t('runtime.approve')}
          </button>
        </div>
      </section>
    </div>
  );
}
