import { lazy, Suspense, useEffect, useState } from 'react';
import { Code2, FolderTree, Microchip } from 'lucide-react';
import { useStudio } from './workspace/useStudio';
import { StudioHeader } from './components/StudioHeader';
import { ProjectExplorer } from './components/ProjectExplorer';
import { EditorWorkspace } from './components/EditorWorkspace';
import { ConsolePanel } from './components/ConsolePanel';
import { DeviceInspector } from './components/DeviceInspector';
import { StudioStatusBar } from './components/StudioStatusBar';
import { StudioDialogs } from './components/StudioDialogs';
import { FirmwareTools } from './components/FirmwareTools';
import { useAutomationCommands } from './workspace/useAutomationCommands';
import { GitPanel } from './components/GitPanel';
import { HostFilePicker } from './components/HostFilePicker';
import { ProjectPackageDialog } from './components/ProjectPackageDialog';
import { ProjectSettingsDialog } from './components/ProjectSettingsDialog';
import { BuildSettingsLauncher } from './components/BuildSettingsLauncher';
import { ComponentLibrariesLauncher } from './components/ComponentLibrariesLauncher';
import { RuntimePluginTrustDialog } from './components/RuntimePluginTrustDialog';
import { RuntimeContributions } from './components/RuntimeContributions';
import { DesktopLifecycle } from './components/DesktopLifecycle';
const RuntimeViewPage = lazy(() =>
  import('./components/RuntimeViewPage').then((module) => ({ default: module.RuntimeViewPage })),
);
import './styles/web-responsive.css';

const HardwareDebuggerView = lazy(() =>
  import('./components/HardwareDebuggerView').then((module) => ({ default: module.HardwareDebuggerView })),
);

/** Compose workspace surfaces. State, effects and operations belong to useStudio. */
export default function App() {
  return (
    <>
      {window.location.hash.startsWith('#/runtime-view/') ? (
        <Suspense fallback={<div />}>
          <RuntimeViewPage />
        </Suspense>
      ) : window.location.hash === '#/hardware-debugger' ? (
        <Suspense fallback={<div className="editor-empty">Blode Studio</div>}>
          <HardwareDebuggerView />
        </Suspense>
      ) : (
        <WorkspaceApp />
      )}
      <HostFilePicker />
    </>
  );
}
function WorkspaceApp() {
  const studio = useStudio();
  useAutomationCommands(studio);
  const { widths, resize } = studio;
  const [mobilePanel, setMobilePanel] = useState<'files' | 'editor' | 'device'>('editor');
  useEffect(() => {
    setMobilePanel('editor');
  }, [studio.activePath, studio.state?.projectRoot]);
  useEffect(() => {
    if (!studio.devicePanelVisible && mobilePanel === 'device') setMobilePanel('editor');
  }, [studio.devicePanelVisible, mobilePanel]);
  const showResources = !!studio.state?.workspaceOpen;
  const columns = [
    ...(showResources ? [`${widths.left}px`, '5px'] : []),
    'minmax(300px, 1fr)',
    ...(studio.devicePanelVisible ? ['5px', `${widths.right}px`] : []),
  ];
  return (
    <div className={`studio${studio.isWeb ? ' web-studio' : ''}`} data-mobile-panel={mobilePanel}>
      <StudioHeader studio={studio} />
      {studio.isWeb && (
        <nav className="web-workspace-switcher" aria-label={studio.t('mobile.workspace')}>
          <button
            className={mobilePanel === 'files' ? 'active' : ''}
            disabled={!showResources}
            onClick={() => setMobilePanel('files')}
          >
            <FolderTree size={14} />
            {studio.t('mobile.files')}
          </button>
          <button
            className={mobilePanel === 'editor' ? 'active' : ''}
            onClick={() => setMobilePanel('editor')}
          >
            <Code2 size={14} />
            {studio.t('mobile.editor')}
          </button>
          <button
            className={mobilePanel === 'device' ? 'active' : ''}
            onClick={() => {
              studio.setDevicePanelVisible(true);
              setMobilePanel('device');
            }}
          >
            <Microchip size={14} />
            {studio.t('mobile.device')}
          </button>
        </nav>
      )}
      <main
        className="workspace"
        style={{ gridTemplateColumns: columns.join(' ') }}
        onClickCapture={(event) => {
          if (studio.isWeb && (event.target as HTMLElement).closest('.project-panel button.is-file'))
            setMobilePanel('editor');
        }}
      >
        {showResources && <ProjectExplorer studio={studio} />}
        {showResources && <div className="splitter" onPointerDown={(event) => resize('left', event)} />}
        <section
          className={`center-panel${studio.consolePanelVisible ? ' with-console' : ''}`}
          style={{
            gridTemplateRows: studio.consolePanelVisible
              ? `minmax(180px, 1fr) 5px ${widths.bottom}px`
              : 'minmax(180px, 1fr)',
          }}
        >
          <EditorWorkspace studio={studio} />
          {studio.consolePanelVisible && (
            <div className="splitter horizontal" onPointerDown={(event) => resize('bottom', event)} />
          )}
          <ConsolePanel studio={studio} />
        </section>
        {studio.devicePanelVisible && (
          <div className="splitter" onPointerDown={(event) => resize('right', event)} />
        )}
        {studio.devicePanelVisible && <DeviceInspector studio={studio} />}
      </main>
      <StudioStatusBar studio={studio} />
      <StudioDialogs studio={studio} />
      <FirmwareTools />
      <GitPanel studio={studio} />
      <ProjectPackageDialog studio={studio} />
      <ProjectSettingsDialog studio={studio} />
      <BuildSettingsLauncher studio={studio} />
      <ComponentLibrariesLauncher studio={studio} />
      <RuntimePluginTrustDialog studio={studio} />
      <RuntimeContributions studio={studio} />
      <DesktopLifecycle studio={studio} />
    </div>
  );
}
