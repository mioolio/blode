import { CircleAlert, MemoryStick, Network, TriangleAlert, Usb } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { bytes } from '../utils';
import { projectFootprint } from '../workspace/resources';
import { useEditorProblems } from '../workspace/editorProblems';

/** StudioStatusBar renders one workspace surface; application actions stay in useStudio. */
export function StudioStatusBar({ studio }: { studio: Studio }) {
  const { t, busy, errors, warnings, state, config, setView, drafts, usesStlink, isAuto, setTab } = studio;
  const editorProblems = useEditorProblems();
  const errorCount =
    errors.length + editorProblems.filter((problem) => problem.severity === 'error').length;
  const warningCount =
    warnings.length + editorProblems.filter((problem) => problem.severity === 'warning').length;
  const footprint = projectFootprint(state?.inventory, state?.files ?? [], drafts);
  const appCapacity =
    config?.partitions
      .filter((partition) => partition.type === 'app')
      .reduce((sum, partition) => sum + partition.size, 0) ?? 0;
  const flashTotal = appCapacity || state?.lastBuild?.flashTotal || 0;
  const automaticChoice = isAuto && (!config?.programmer || config.programmer.transport === 'auto');
  const connectedDevice = automaticChoice
    ? ''
    : usesStlink
      ? state?.debugProbes.some(
          (probe) => probe.serialNumber.toLowerCase() === config?.programmer?.serialNumber.toLowerCase(),
        ) &&
        config?.programmer?.serialNumber &&
        `ST-Link ${config.programmer.serialNumber}`
      : state?.connections?.serial.open
        ? state.connections.serial.port
        : '';
  return (
    <footer className="statusbar">
      <span className="status-left">
        <span className={`status-dot ${busy ? 'amber' : ''}`} />
        {t(busy ? 'status.busy' : 'status.ready')}
        <i />
        <button
          className={`status-item ${errorCount ? 'error-text' : ''}`}
          onClick={() => setTab('problems')}
        >
          <CircleAlert size={11} strokeWidth={2} aria-hidden="true" />
          {t('status.errors')} {errorCount}
        </button>
        <button className="status-item" onClick={() => setTab('warnings')}>
          <TriangleAlert size={11} strokeWidth={2} aria-hidden="true" />
          {t('status.warnings')} {warningCount}
        </button>
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
        <span className={`status-item ${connectedDevice ? '' : 'muted'}`}>
          <Usb size={11} strokeWidth={2} aria-hidden="true" />
          {connectedDevice ||
            t(
              !state || state.initializing
                ? 'device.connectionChecking'
                : automaticChoice
                  ? 'device.autoSelection'
                  : 'status.offline',
            )}
        </span>
        <i />
        <span className="status-item">
          <MemoryStick size={11} strokeWidth={2} aria-hidden="true" />
          {state?.lastBuild?.success
            ? `${t('memory.flash')} ${bytes(state.lastBuild.flashUsed)} / ${bytes(flashTotal)}`
            : `${t('resource.appCapacity')} ${bytes(flashTotal)}`}
        </span>
      </span>
    </footer>
  );
}
