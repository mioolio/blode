import { lazy, Suspense, useEffect, useState } from 'react';
import type { Studio } from '../workspace/useStudio';

const BuildSettingsDialog = lazy(() => import('./BuildSettingsDialog'));

export function BuildSettingsLauncher({ studio }: { studio: Studio }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('blode:build-settings', show);
    return () => window.removeEventListener('blode:build-settings', show);
  }, []);
  useEffect(() => setOpen(false), [studio.state?.projectRoot]);
  if (!open || !studio.state?.workspaceOpen) return null;
  return (
    <Suspense
      fallback={
        <div className="modal-backdrop">
          <div role="status">{studio.t('buildSettings.loading')}</div>
        </div>
      }
    >
      <BuildSettingsDialog studio={studio} onClose={() => setOpen(false)} />
    </Suspense>
  );
}
