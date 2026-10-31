import { lazy, Suspense, useEffect, useState } from 'react';
import type { Studio } from '../workspace/useStudio';

const BuildSettingsDialog = lazy(() => import('./BuildSettingsDialog'));

export function BuildSettingsLauncher({ studio }: { studio: Studio }) {
  const [revision, setRevision] = useState<number>();
  useEffect(() => {
    const show = () => setRevision((current) => (current ?? 0) + 1);
    window.addEventListener('blode:build-settings', show);
    return () => window.removeEventListener('blode:build-settings', show);
  }, []);
  useEffect(() => setRevision(undefined), [studio.state?.projectRoot]);
  if (revision === undefined) return null;
  return (
    <Suspense
      fallback={
        <div className="modal-backdrop">
          <div role="status">{studio.t('buildSettings.loading')}</div>
        </div>
      }
    >
      <BuildSettingsDialog key={revision} studio={studio} onClose={() => setRevision(undefined)} />
    </Suspense>
  );
}
