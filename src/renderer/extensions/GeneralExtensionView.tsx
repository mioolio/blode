import { useEffect, useRef, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { openGeneralExtensionView, updateGeneralExtensions } from './ShellAppearance';
import './general-extensions.css';
import '../components/runtime-surfaces.css';

export function GeneralExtensionView({ id, view }: { id: string; view: string }) {
  const { t, locale } = useI18n(),
    frame = useRef<HTMLIFrameElement>(null);
  const [documentUrl, setDocumentUrl] = useState({ key: '', url: '' }),
    [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  // A new WindowProxy prevents queued messages from an old package reaching a new package's bridge.
  const frameKey = `${id}/${view}/${locale}/${attempt}`;
  useEffect(() => {
    let active = true;
    setDocumentUrl({ key: frameKey, url: '' });
    setError('');
    void window.blode.generalExtensionViewUrl({ id, view }).then(
      (value) => {
        if (active) setDocumentUrl({ key: frameKey, url: value });
      },
      (error) => {
        if (active) setError(t(error instanceof Error ? error.message : String(error)));
      },
    );
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (
        event.source !== frame.current?.contentWindow ||
        message?.channel !== 'blode-extension-ui' ||
        typeof message.id !== 'string' ||
        message.id.length > 80 ||
        !['context.get', 'settings.update', 'view.open'].includes(message.method) ||
        !Array.isArray(message.args) ||
        message.args.length > 1
      )
        return;
      try {
        if (JSON.stringify(message).length > 32768) return;
      } catch {
        return;
      }
      const target = frame.current?.contentWindow;
      const invoke = async () => {
        if (message.method === 'context.get')
          return { ...(await window.blode.generalExtensionContext({ id })), locale };
        if (message.method === 'settings.update') {
          const result = await window.blode.generalExtensionConfigure({ id, values: message.args[0] });
          updateGeneralExtensions(result);
          return { ...result.plugins.find((plugin) => plugin.id === id), locale };
        }
        const plugin = await window.blode.generalExtensionContext({ id }),
          contribution = plugin.manifest.ui.views?.find((view) => view.id === message.args[0]);
        if (!contribution) throw Error('error.extensionPermission');
        return openGeneralExtensionView(plugin, contribution);
      };
      void invoke().then(
        (result) => {
          if (active && target === frame.current?.contentWindow)
            target?.postMessage({ channel: 'blode-extension-ui', id: message.id, result }, '*');
        },
        (error) => {
          if (active && target === frame.current?.contentWindow)
            target?.postMessage(
              {
                channel: 'blode-extension-ui',
                id: message.id,
                error: error instanceof Error ? error.message : String(error),
              },
              '*',
            );
        },
      );
    };
    window.addEventListener('message', receive);
    return () => {
      active = false;
      window.removeEventListener('message', receive);
    };
  }, [id, view, locale, attempt]);
  return error ? (
    <div className="extension-view-error" role="alert">
      {error}
      <button onClick={() => retry((value) => value + 1)}>{t('action.refresh')}</button>
    </div>
  ) : (
    <iframe
      key={frameKey}
      ref={frame}
      className="general-extension-frame"
      title={`${id} ${view}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={documentUrl.key === frameKey ? documentUrl.url || 'about:blank' : 'about:blank'}
    />
  );
}
export function GeneralExtensionViewPage() {
  const { t } = useI18n();
  let parts: string[] = [];
  try {
    parts = window.location.hash.slice('#/extension-view/'.length).split('/').map(decodeURIComponent);
  } catch {
    /* Invalid links render the standard missing-view state. */
  }
  const valid = parts.length === 2 && parts.every((part) => /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(part));
  return (
    <main className="runtime-window">
      <header className="runtime-window-bar">
        <span>Blode Studio</span>
        {window.__blodeFrameless && (
          <div>
            {(['minimize', 'maximize', 'close'] as const).map((action, i) => (
              <button
                key={action}
                aria-label={t(`window.${action}`)}
                onClick={() => window.blode.windowAction(action)}
              >
                {i === 0 ? <Minus size={14} /> : i === 1 ? <Square size={13} /> : <X size={16} />}
              </button>
            ))}
          </div>
        )}
      </header>
      <section className="runtime-window-content">
        {valid ? (
          <GeneralExtensionView id={parts[0]} view={parts[1]} />
        ) : (
          <p>{t('error.extensionMissing')}</p>
        )}
      </section>
    </main>
  );
}
