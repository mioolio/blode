import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import './runtime-plugin.css';
import type { RuntimeViewKind, RuntimeViewContribution } from '../../shared/plugins';
import { openRuntimeContribution } from '../workspace/runtimeViewActions';

const methods = new Set([
  'state',
  'connect',
  'disconnect',
  'action',
  'storage',
  'symbolsFile',
  'selectGdb',
  'breakpoint',
  'memory',
]);

/** Custom markup runs in an opaque-origin frame; only the declared debug bridge crosses it. */
export function RuntimePluginView({ id, kind }: { id: string; kind: RuntimeViewKind }) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [openError, setOpenError] = useState('');
  const [revision, setRevision] = useState(0);
  const [pendingView, setPendingView] = useState<RuntimeViewContribution | null>(null);
  useEffect(() => {
    const trusted = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) setRevision((value) => value + 1);
    };
    window.addEventListener('blode:runtime-plugin-trusted', trusted);
    return () => window.removeEventListener('blode:runtime-plugin-trusted', trusted);
  }, [id]);
  useEffect(() => {
    let disposed = false;
    setHtml('');
    setError('');
    setOpenError('');
    setPendingView(null);
    void window.blode
      .runtimePluginViewDocument(id, kind)
      .then((value) => {
        if (!disposed) setHtml(value ?? '');
      })
      .catch((value) => {
        if (!disposed) setError(t(value instanceof Error ? value.message : String(value)));
      });
    return () => {
      disposed = true;
    };
  }, [id, kind, revision]);
  useEffect(() => {
    let active = true;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        event.data.channel !== 'blode-runtime-ui'
      )
        return;
      const request = event.data;
      if (
        typeof request.id !== 'string' ||
        request.id.length > 80 ||
        typeof request.method !== 'string' ||
        (!methods.has(request.method) &&
          !['context.get', 'config.update', 'device.invoke', 'view.open'].includes(request.method)) ||
        !Array.isArray(request.args) ||
        request.args.length > 8
      )
        return;
      try {
        if (JSON.stringify(request).length > 32768) return;
      } catch {
        return;
      }
      const target = frame.current?.contentWindow;
      const action =
        request.method === 'view.open'
          ? async () => {
              const view = await window.blode.runtimePluginViewInfo(id, request.args[0]);
              try {
                return await openRuntimeContribution(id, view);
              } catch (error) {
                if (error instanceof Error && error.message === 'error.popupBlocked') setPendingView(view);
                throw error;
              }
            }
          : request.method === 'context.get'
            ? () => window.blode.runtimePluginContext(id)
            : request.method === 'config.update'
              ? () => window.blode.runtimePluginConfigure(id, request.args[0])
              : request.method === 'device.invoke'
                ? () =>
                    window.blode.runtimePluginDevice(id, request.args[0], request.args[1], request.args[2])
                : () => window.blode.runtimePluginDebug(id, request.method, request.args);
      void Promise.resolve()
        .then(action)
        .then(
          (result) => {
            if (active && target === frame.current?.contentWindow)
              target?.postMessage({ channel: 'blode-runtime-ui', id: request.id, result }, '*');
          },
          (value) => {
            if (active && target === frame.current?.contentWindow)
              target?.postMessage(
                {
                  channel: 'blode-runtime-ui',
                  id: request.id,
                  error: value instanceof Error ? value.message : String(value),
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
  }, [id, kind, revision]);
  if (error)
    return (
      <div className="runtime-view-error" role="status">
        {error}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('blode:runtime-plugin-review', { detail: id }))}
        >
          {t('runtime.review')}
        </button>
      </div>
    );
  if (!html) return null;
  return (
    <>
      {pendingView && (
        <button
          className="text-button"
          onClick={() => {
            setOpenError('');
            void openRuntimeContribution(id, pendingView)
              .then(() => setPendingView(null))
              .catch((value) => setOpenError(t(value instanceof Error ? value.message : String(value))));
          }}
        >
          {t('runtime.openTab')}
        </button>
      )}
      {openError && (
        <p className="runtime-open-error" role="alert">
          {openError}
        </p>
      )}
      <iframe
        ref={frame}
        title={`${id} ${kind}`}
        className="runtime-plugin-view"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={html}
      />
    </>
  );
}
