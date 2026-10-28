import { CircleAlert, MemoryStick, Network, TriangleAlert, Usb } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { bytes } from '../utils';
import { projectFootprint } from '../workspace/resources';

/** StudioStatusBar renders one workspace surface; application actions stay in useStudio. */
export function StudioStatusBar({ studio }: { studio: Studio }) {
  const { t, busy, errors, warnings, state, config, setView, drafts } = studio;
  const footprint = projectFootprint(state?.inventory, state?.files ?? [], drafts);
  return (
    <footer className="statusbar">
      <span className="status-left">
        <span className={`status-dot ${busy ? 'amber' : ''}`} />
        {t(busy ? 'status.busy' : 'status.ready')}
        <i />
        <span className={`status-item ${errors.length ? 'error-text' : ''}`}>
          <CircleAlert size={11} strokeWidth={2} aria-hidden="true" />
          {t('status.errors')} {errors.length}
        </span>
        <span className="status-item">
          <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" />
          {t('status.warnings')} {warnings.length}
        </span>
      </span>
      <span className="status-center">
        {!state?.workspaceOpen
          ? t('welcome.noWorkspace')
          : busy
            ? t(busy)
            : `${footprint.fileCount} ${t('resource.files')} · ${bytes(footprint.totalBytes)}`}
      </span>
      <span className="status-right">
        <button className="status-item" onClick={() => setView('ai')}>
          <Network size={11} strokeWidth={2} aria-hidden="true" />
          MCP
        </button>
        <i />
        <span className={`status-item ${config?.port ? '' : 'muted'}`}>
          <Usb size={11} strokeWidth={2} aria-hidden="true" />
          {config?.port || t('status.offline')}
        </span>
        <i />
        <span className="status-item">
          <MemoryStick size={11} strokeWidth={2} aria-hidden="true" />
          {state?.lastBuild?.success
            ? `${t('memory.flash')} ${bytes(state.lastBuild.flashUsed)} / ${bytes(state.lastBuild.flashTotal)}`
            : `${t('resource.appCapacity')} ${bytes(config?.partitions.find((partition) => partition.type === 'app')?.size ?? 0)}`}
        </span>
      </span>
    </footer>
  );
}
