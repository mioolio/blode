import { lazy, Suspense, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { applyShellAppearance, useGeneralExtensions } from './ShellAppearance';
import './general-extensions.css';
const ExtensionManager = lazy(() => import('./ExtensionManager'));
export function ExtensionHost() {
  const { t } = useI18n(),
    { data } = useGeneralExtensions();
  const [open, setOpen] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const show = () => setOpen(true),
      failure = (event: Event) => setError(t((event as CustomEvent<string>).detail));
    window.addEventListener('blode:extensions', show);
    window.addEventListener('blode:extension-error', failure);
    return () => {
      window.removeEventListener('blode:extensions', show);
      window.removeEventListener('blode:extension-error', failure);
    };
  }, [t]);
  useEffect(() => applyShellAppearance(document.documentElement, data?.plugins ?? []), [data]);
  return (
    <>
      {error && (
        <div className="extension-toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')}>×</button>
        </div>
      )}
      {open && (
        <Suspense fallback={null}>
          <ExtensionManager onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
