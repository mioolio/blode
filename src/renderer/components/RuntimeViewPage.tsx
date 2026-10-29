import { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { RuntimePluginView } from './RuntimePluginView';
import { RuntimePluginTrustDialog } from './RuntimePluginTrustDialog';
import { useI18n } from '../i18n';
import './runtime-surfaces.css';

export function RuntimeViewPage() {
  const { t } = useI18n();
  const parts = window.location.hash.slice('#/runtime-view/'.length).split('/');
  let id = '',
    viewId = '';
  try {
    [id, viewId] = parts.map(decodeURIComponent);
  } catch {}
  const valid =
    parts.length === 2 && [id, viewId].every((value) => /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value));
  const [title, setTitle] = useState('Blode Studio');
  useEffect(() => {
    if (!valid) return;
    void window.blode
      .runtimePluginsState()
      .then((state) => {
        const label = state.plugins
          .find((plugin) => plugin.id === id)
          ?.manifest.ui.views?.find((view) => view.id === viewId)?.label;
        if (label) {
          setTitle(label);
          document.title = label;
        }
      })
      .catch(() => {});
  }, [id, viewId, valid]);
  return (
    <main className="runtime-window">
      <header className="runtime-window-bar">
        <span>{title}</span>
        {window.__blodeFrameless && (
          <div>
            {(['minimize', 'maximize', 'close'] as const).map((action, index) => (
              <button
                key={action}
                aria-label={t(`window.${action}`)}
                onClick={() => window.blode.windowAction(action)}
              >
                {index === 0 ? <Minus size={14} /> : index === 1 ? <Square size={13} /> : <X size={16} />}
              </button>
            ))}
          </div>
        )}
      </header>
      <section className="runtime-window-content">
        {valid ? (
          <RuntimePluginView id={id} kind={`view:${viewId}`} />
        ) : (
          <p role="alert">{t('error.runtimePluginCapability')}</p>
        )}
      </section>
      {valid && <RuntimePluginTrustDialog id={id} />}
    </main>
  );
}
