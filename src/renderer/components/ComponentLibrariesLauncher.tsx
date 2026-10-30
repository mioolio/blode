import { lazy, Suspense, useEffect, useState } from 'react';
import type { Studio } from '../workspace/useStudio';

const ComponentLibrariesDialog = lazy(() => import('./ComponentLibrariesDialog'));

export function ComponentLibrariesLauncher({ studio }: { studio: Studio }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('blode:component-libraries', show);
    return () => window.removeEventListener('blode:component-libraries', show);
  }, []);
  useEffect(() => setOpen(false), [studio.state?.projectRoot]);
  if (!open) return null;
  return (
    <Suspense
      fallback={
        <div className="modal-backdrop">
          <div role="status">{studio.t('components.loading')}</div>
        </div>
      }
    >
      <ComponentLibrariesDialog studio={studio} onClose={() => setOpen(false)} />
    </Suspense>
  );
}
