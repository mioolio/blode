import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Bot,
  ChevronRight,
  Columns2,
  FileCode,
  FolderOpen,
  LayoutGrid,
  Settings2,
  X,
} from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { FileIcon } from './FileIcon';
import { CodeEditor } from '../editor/CodeEditor';
import { PartitionLayout } from './PartitionLayout';
import { Settings } from './Settings';
import { AiWorkspace } from './AiWorkspace';

const tools = [
  { id: 'layout' as const, icon: LayoutGrid, label: 'workspace.layout' },
  { id: 'ai' as const, icon: Bot, label: 'workspace.ai' },
  { id: 'settings' as const, icon: Settings2, label: 'workspace.settings' },
];

/** EditorWorkspace renders the tabbed editor and its tool views. */
export function EditorWorkspace({ studio }: { studio: Studio }) {
  const {
    t,
    view,
    state,
    config,
    board,
    activePath,
    openFiles,
    openTools,
    openFile,
    closeTab,
    setView,
    openProject,
    openProjectMarker,
    drafts,
    setDrafts,
    source,
    lines,
    setStale,
    setConfig,
    saveConfig,
    busy,
    install,
    copy,
    syncDrafts,
    setSyncDrafts,
  } = studio;
  const segments = activePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const fileTabs = openFiles.flatMap((path) => {
    const file = state?.files.find((item) => item.path === path);
    return file ? [file] : [];
  });
  const [secondaryPath, setSecondaryPath] = useState('');
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const splitRegion = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (secondaryPath && !state?.files.some((file) => file.path === secondaryPath)) setSecondaryPath('');
  }, [secondaryPath, state?.files]);

  const toggleSplit = () => {
    if (secondaryPath) {
      setSecondaryPath('');
      return;
    }
    setSecondaryPath(openFiles.find((path) => path !== activePath) ?? openFiles[0] ?? '');
  };

  const beginSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const region = splitRegion.current;
    if (!region) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const bounds = region.getBoundingClientRect();
      setSplitRatio(Math.min(0.75, Math.max(0.25, (pointer.clientX - bounds.left) / bounds.width)));
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
  };

  const renderEditor = (path: string, primary = false) => {
    const file = state?.files.find((item) => item.path === path);
    if (!file)
      return (
        <div className="editor-empty">
          <FileCode size={40} strokeWidth={1.2} aria-hidden="true" />
          <span>{t(state ? 'editor.noFile' : 'editor.loading')}</span>
        </div>
      );
    return (
      <CodeEditor
        path={`${state?.projectRoot}/${path}`}
        language={file.language}
        value={drafts[path] ?? file.content}
        onCursor={primary ? (position) => setCursor(position) : undefined}
        onChange={(value) => {
          setDrafts((current) => {
            const next = { ...current };
            if (value === file.content) delete next[path];
            else next[path] = value;
            return next;
          });
          setStale(true);
        }}
      />
    );
  };

  return (
    <div className="editor-region">
      {!state?.workspaceOpen && view !== 'ai' ? (
        <div className="welcome-view">
          <span className="welcome-icon">
            <FolderOpen size={30} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <h2>{t('welcome.title')}</h2>
          <p>{t('welcome.body')}</p>
          <button className="primary" onClick={openProjectMarker} disabled={!!busy || !state}>
            <FileCode size={14} strokeWidth={1.9} aria-hidden="true" />
            {t('welcome.selectMarker')}
          </button>
          <button className="secondary" onClick={openProject} disabled={!!busy || !state}>
            <FolderOpen size={14} strokeWidth={1.9} aria-hidden="true" />
            {t('project.openFolder')}
          </button>
          <p className="subtle-note">{t('welcome.marker')}</p>
        </div>
      ) : (
        <>
      <div className="editor-tabs">
        {fileTabs.map((file) => {
          const active = view === 'code' && activePath === file.path;
          return (
            <div className={`editor-tab ${active ? 'active' : ''}`} key={file.path}>
              <button className="tab-main" onClick={() => openFile(file.path)} title={file.path}>
                <FileIcon name={file.path} size={14} />
                <span className="tab-name">{file.path.split('/').pop()}</span>
                {drafts[file.path] !== undefined && (
                  <span className="tab-dirty" aria-label={t('project.unsaved')}>
                    *
                  </span>
                )}
              </button>
              <button
                className="tab-close"
                aria-label={t('action.close')}
                title={t('action.close')}
                onClick={() => closeTab('file', file.path)}
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {openTools.map((id) => {
          const tool = tools.find((item) => item.id === id);
          if (!tool) return null;
          const Icon = tool.icon;
          const active = view === tool.id;
          return (
            <div className={`editor-tab tool-tab ${active ? 'active' : ''}`} key={tool.id}>
              <button className="tab-main" onClick={() => setView(tool.id)}>
                <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
                <span className="tab-name">{t(tool.label)}</span>
              </button>
              <button
                className="tab-close"
                aria-label={t('action.close')}
                title={t('action.close')}
                onClick={() => closeTab('tool', tool.id)}
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <span className="editor-tabs-spacer" />
        {view === 'code' && (
          <button
            className={`editor-split-toggle ${secondaryPath ? 'active' : ''}`}
            onClick={toggleSplit}
            title={t(secondaryPath ? 'action.close' : 'action.splitEditor')}
            aria-label={t('action.splitEditor')}
            aria-pressed={!!secondaryPath}
            disabled={!fileTabs.length}
          >
            <Columns2 size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
        )}
      </div>

      {view === 'code' ? (
        <>
          <div className="breadcrumbs">
            <span className="crumb">
              <FolderOpen size={12} strokeWidth={1.8} aria-hidden="true" />
              {config?.name}
            </span>
            {segments.map((segment, index) => (
              <Fragment key={`${segment}-${index}`}>
                <ChevronRight className="crumb-sep" size={11} aria-hidden="true" />
                <span className={index === segments.length - 1 ? 'crumb-current' : ''}>{segment}</span>
              </Fragment>
            ))}
            <span className="editor-language">
              {source?.language === 'cpp' ? t('editor.cpp') : source?.language}
            </span>
          </div>
          <div className="monaco-container">
            {secondaryPath ? (
              <div
                className="editor-split"
                ref={splitRegion}
                style={{
                  gridTemplateColumns: `minmax(0, ${splitRatio}fr) 5px minmax(0, ${1 - splitRatio}fr)`,
                }}
              >
                <div className="editor-pane">
                  <div className="monaco-container">{renderEditor(activePath, true)}</div>
                </div>
                <div
                  className="editor-split-divider"
                  role="separator"
                  aria-orientation="vertical"
                  title={t('action.splitEditor')}
                  onPointerDown={beginSplitDrag}
                />
                <div className="editor-pane">
                  <div className="split-pane-header">
                    <span>{t('action.splitEditor')}</span>
                    <select
                      value={secondaryPath}
                      aria-label={t('action.splitEditor')}
                      onChange={(event) => setSecondaryPath(event.target.value)}
                    >
                      {fileTabs.map((file) => (
                        <option key={file.path} value={file.path}>
                          {file.path}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="monaco-container">{renderEditor(secondaryPath)}</div>
                </div>
              </div>
            ) : (
              renderEditor(activePath, true)
            )}
          </div>
          <div className="editor-footer">
            <span className="footer-position">
              {t('status.line')} {cursor.line}, {t('status.column')} {cursor.column}
            </span>
            <span>
              {lines.length} {t('editor.lines')}
              <i />
              {t('status.encoding')}
            </span>
          </div>
        </>
      ) : config && state ? (
        view === 'layout' ? (
          <PartitionLayout
            config={config}
            flashSizes={board?.flashSizes}
            customFlashSize={board?.customFlashSize}
            onChange={(value) => {
              setConfig(value);
              setStale(true);
            }}
            onSave={saveConfig}
            busy={!!busy}
          />
        ) : view === 'settings' ? (
          <Settings
            config={config}
            status={state.toolchain}
            onChange={setConfig}
            onSave={saveConfig}
            onInstall={install}
            busy={!!busy}
          />
        ) : (
          <AiWorkspace
            endpoint={state.pipe.endpoint}
            tokenFile={state.pipe.tokenFile}
            webEndpoint={state.web?.endpoint ?? ''}
            webTokenFile={state.web?.tokenFile ?? ''}
            allowExternal={state.web?.allowExternal ?? false}
            syncDrafts={syncDrafts}
            onSyncChange={setSyncDrafts}
            onCopy={copy}
          />
        )
      ) : (
        <div className="editor-empty">
          <FileCode size={40} strokeWidth={1.2} aria-hidden="true" />
        </div>
      )}
        </>
      )}
    </div>
  );
}
