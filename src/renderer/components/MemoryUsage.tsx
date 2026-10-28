import { FolderTree, Gauge } from 'lucide-react';
import type { AppState, ProjectConfig } from '../../shared/contracts';
import { useI18n } from '../i18n';
import { bytes, percentage } from '../utils';
import { projectFootprint } from '../workspace/resources';

/** Pre-build disk/layout facts are separate from linked firmware measurements. */
export function MemoryUsage({
  state,
  config,
  drafts,
  stale,
}: {
  state: AppState | null;
  config: ProjectConfig | null;
  drafts: Record<string, string>;
  stale: boolean;
}) {
  const { t } = useI18n();
  const footprint = projectFootprint(state?.inventory, state?.files ?? [], drafts);
  const build = state?.lastBuild?.success ? state.lastBuild : null;
  const board = state?.boards.find((item) => item.id === config?.boardId);
  const appCapacity =
    config?.partitions
      .filter((partition) => partition.type === 'app')
      .reduce((sum, partition) => sum + partition.size, 0) ?? 0;
  return (
    <>
      <section className="inspector-section project-usage">
        <div className="section-heading">
          <span className="heading-label">
            <FolderTree size={12} strokeWidth={1.9} aria-hidden="true" />
            {t('resource.projectBytes')}
          </span>
        </div>
        <dl className="resource-facts">
          <div>
            <dt>{t('editor.source')}</dt>
            <dd>{bytes(footprint.totalBytes)}</dd>
          </div>
          <div>
            <dt>{t('resource.files')}</dt>
            <dd>{footprint.fileCount}</dd>
          </div>
          <div>
            <dt>{t('resource.folders')}</dt>
            <dd>{footprint.directoryCount}</dd>
          </div>
        </dl>
        {footprint.groups.length > 0 && (
          <div className="directory-usage" aria-label={t('resource.groupDistribution')}>
            {footprint.groups.slice(0, 8).map((group) => (
              <div key={group.path} className="directory-usage-row">
                <span title={group.path}>{group.path}</span>
                <span>{bytes(group.bytes)}</span>
                <div className="distribution-track">
                  <i style={{ width: `${percentage(group.bytes, footprint.totalBytes)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="subtle-note">
          {t(footprint.truncated ? 'resource.truncated' : 'resource.sourceNotice')}
        </p>
      </section>
      <section className="inspector-section memory-section">
        <div className="section-heading">
          <span className="heading-label">
            <Gauge size={12} strokeWidth={1.9} aria-hidden="true" />
            {t('memory.title')}
          </span>
          <span className="measurement-state">
            {t(
              build
                ? stale || state?.buildStale
                  ? 'memory.previous'
                  : 'memory.compiled'
                : 'memory.uncompiled',
            )}
          </span>
        </div>
        <dl className="resource-facts">
          <div>
            <dt>{t('resource.physicalFlash')}</dt>
            <dd>{bytes(config?.flashSize ?? 0)}</dd>
          </div>
          <div>
            <dt>{t('resource.appCapacity')}</dt>
            <dd>{bytes(appCapacity)}</dd>
          </div>
        </dl>
        {(['flash', 'ram'] as const).map((type) => {
          const known = !!build && (type === 'flash' || build.ramTotal > 0);
          const used = type === 'flash' ? (build?.flashUsed ?? 0) : (build?.ramUsed ?? 0);
          const total =
            type === 'flash' ? (build?.flashTotal ?? appCapacity) : (build?.ramTotal ?? board?.ramSize ?? 0);
          return (
            <div className={`memory-meter ${type}`} key={type}>
              <div className="meter-title">
                <span>{t(`memory.${type}`)}</span>
                <strong>{known ? `${percentage(used, total).toFixed(1)}%` : t('memory.unmeasured')}</strong>
              </div>
              <div className={`meter-track ${known ? '' : 'unmeasured'}`}>
                <i style={{ width: `${percentage(used, total)}%` }} />
              </div>
              <div className="meter-labels">
                <span>
                  {known ? bytes(used) : t('memory.unmeasured')} / {bytes(total)}
                </span>
                <span>
                  {t('memory.free')} {known ? bytes(Math.max(0, total - used)) : t('memory.unmeasured')}
                </span>
              </div>
            </div>
          );
        })}
        {!build && <p className="subtle-note">{t('resource.pendingFirmware')}</p>}
      </section>
    </>
  );
}
