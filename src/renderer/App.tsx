import { useStudio } from './workspace/useStudio';
import { StudioHeader } from './components/StudioHeader';
import { ProjectExplorer } from './components/ProjectExplorer';
import { EditorWorkspace } from './components/EditorWorkspace';
import { ConsolePanel } from './components/ConsolePanel';
import { DeviceInspector } from './components/DeviceInspector';
import { StudioStatusBar } from './components/StudioStatusBar';
import { StudioDialogs } from './components/StudioDialogs';

/** Compose workspace surfaces. State, effects and operations belong to useStudio. */
export default function App() {
  const studio = useStudio();
  const { widths, resize } = studio;
  return (
    <div className="studio">
      <StudioHeader studio={studio} />
      <main
        className="workspace"
        style={{ gridTemplateColumns: `${widths.left}px 5px minmax(300px, 1fr) 5px ${widths.right}px` }}
      >
        <ProjectExplorer studio={studio} />
        <div className="splitter" onPointerDown={(event) => resize('left', event)} />
        <section
          className="center-panel"
          style={{ gridTemplateRows: `minmax(180px, 1fr) 5px ${widths.bottom}px` }}
        >
          <EditorWorkspace studio={studio} />
          <div className="splitter horizontal" onPointerDown={(event) => resize('bottom', event)} />
          <ConsolePanel studio={studio} />
        </section>
        <div className="splitter" onPointerDown={(event) => resize('right', event)} />
        <DeviceInspector studio={studio} />
      </main>
      <StudioStatusBar studio={studio} />
      <StudioDialogs studio={studio} />
    </div>
  );
}
