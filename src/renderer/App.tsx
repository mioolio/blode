import { useStudio } from './workspace/useStudio';
import { StudioHeader } from './components/StudioHeader';
import { ProjectExplorer } from './components/ProjectExplorer';
import { EditorWorkspace } from './components/EditorWorkspace';
import { ConsolePanel } from './components/ConsolePanel';
import { DeviceInspector } from './components/DeviceInspector';
import { StudioStatusBar } from './components/StudioStatusBar';
import { StudioDialogs } from './components/StudioDialogs';
import { HardwareDebuggerView } from './components/HardwareDebuggerView';
import { FirmwareTools } from './components/FirmwareTools';

/** Compose workspace surfaces. State, effects and operations belong to useStudio. */
export default function App() {
  return window.location.hash === '#/hardware-debugger' ? <HardwareDebuggerView /> : <WorkspaceApp />;
}
function WorkspaceApp() {
  const studio = useStudio();
  const { widths, resize } = studio;
  const showResources = !!studio.state?.workspaceOpen;
  const columns = [
    ...(showResources ? [`${widths.left}px`, '5px'] : []),
    'minmax(300px, 1fr)',
    ...(studio.devicePanelVisible ? ['5px', `${widths.right}px`] : []),
  ];
  return (
    <div className="studio">
      <StudioHeader studio={studio} />
      <main className="workspace" style={{ gridTemplateColumns: columns.join(' ') }}>
        {showResources && <ProjectExplorer studio={studio} />}
        {showResources && <div className="splitter" onPointerDown={(event) => resize('left', event)} />}
        <section
          className="center-panel"
          style={{ gridTemplateRows: `minmax(180px, 1fr) 5px ${widths.bottom}px` }}
        >
          <EditorWorkspace studio={studio} />
          <div className="splitter horizontal" onPointerDown={(event) => resize('bottom', event)} />
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
    </div>
  );
}
