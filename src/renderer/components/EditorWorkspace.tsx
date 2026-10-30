import { ModernSelect } from './ModernSelect';
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useMemo,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Bot, ChevronRight, Columns2, FileCode, FolderOpen, LayoutGrid, Settings2, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { FileIcon } from './FileIcon';
import { setCompletionProject, registerExternalSource } from '../editor/completionProvider';
import type { PreferencesSection } from './Settings';
import { supportsLayout, supportsPartitionEditing } from '../workspace/capabilities';
import { resizeAppRegion, resizeFixedLayout } from '../workspace/layout';
import { WelcomeHome } from './WelcomeHome';
import { useCollaboration } from '../workspace/useCollaboration';
import { CollaborationAvatars, CollaborationStatus } from './CollaborationStatus';
import { visibleFilePaths, type FileClosedEvent } from '../workspace/remoteTabs';
import './preferences.css';
import { EditorLoading } from '../editor/EditorLoading';
import type { SourceLocation } from '../../shared/language';
import { openableFilePaths, workspaceFileView } from '../../shared/file-views';
import { EditorActions } from './EditorActions';
import { SourceNavigation, type NavigationPane } from '../workspace/sourceNavigation';

const CodeEditor = lazy(() =>
  import('../editor/CodeEditor').then((module) => ({ default: module.CodeEditor })),
);
const AssetPreview = lazy(() =>
  import('./AssetPreview').then((module) => ({ default: module.AssetPreview })),
);
const PartitionLayout = lazy(() =>
  import('./PartitionLayout').then((module) => ({ default: module.PartitionLayout })),
);
const ResourceLayout = lazy(() =>
  import('./ResourceLayout').then((module) => ({ default: module.ResourceLayout })),
);
const Settings = lazy(() => import('./Settings').then((module) => ({ default: module.Settings })));
const AiWorkspace = lazy(() => import('./AiWorkspace').then((module) => ({ default: module.AiWorkspace })));

const tools = [
  { id: 'layout' as const, icon: LayoutGrid, label: 'workspace.layout' },
  { id: 'ai' as const, icon: Bot, label: 'workspace.ai' },
];

function greetingKey(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return 'welcome.greetingNight';
  if (hour < 11) return 'welcome.greetingMorning';
  if (hour < 13) return 'welcome.greetingNoon';
  if (hour < 18) return 'welcome.greetingAfternoon';
  if (hour < 23) return 'welcome.greetingEvening';
  return 'welcome.greetingNight';
}

/** EditorWorkspace renders the tabbed editor and its tool views. */
export function EditorWorkspace({ studio }: { studio: Studio }) {
  const collaboration = useCollaboration(studio);
  useEffect(() => {
    const requested = (event: Event) =>
      (
        event as CustomEvent<{ reply: (actor: ReturnType<typeof collaboration.aiActor>) => void }>
      ).detail?.reply(collaboration.aiActor());
    window.addEventListener('blode:ai-actor-request', requested);
    return () => window.removeEventListener('blode:ai-actor-request', requested);
  }, [collaboration.self.peerId]);
  useEffect(() => {
    const conflict = () => studio.notify(studio.t('collaboration.undoConflict'), false, true);
    window.addEventListener('blode:undo-conflict', conflict);
    return () => window.removeEventListener('blode:undo-conflict', conflict);
  }, [studio.notify, studio.t]);
  const {
    t,
    view,
    state,
    config,
    board,
    activePath,
    openFiles,
    openTools,
    previewPath,
    pinFile,
    showHome,
    closeProjectPending,
    setCloseProjectPending,
    closeProject,
    openFile,
    closeTab,
    setView,
    drafts,
    setDrafts,
    source,
    lines,
    stale,
    setStale,
    setConfig,
    saveConfig,
    busy,
    install,
    installDriver,
    refreshDrivers,
    copy,
    syncDrafts,
    setSyncDrafts,
    isWeb,
  } = studio;
  const segments = activePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const toolTabs = visibleFilePaths(openTools, collaboration.remoteTools, new Set());
  const availableFiles = useMemo(
    () => new Set([...openableFilePaths(state), ...Object.keys(studio.externalFiles)]),
    [state?.files, state?.inventory, studio.externalFiles],
  );
  const fileTabs = visibleFilePaths(openFiles, collaboration.remotePaths, new Set())
    .filter((path) => availableFiles.has(path))
    .map((path) => ({ path }));
  const layoutAvailable = supportsLayout(board);
  const partitionEditor = supportsPartitionEditing(board);
  const lastBuild = state?.lastBuild?.success ? state.lastBuild : null;
  const probeSerial = config?.programmer?.serialNumber.toLowerCase();
  const probe = probeSerial
    ? state?.debugProbes.find((item) => item.serialNumber.toLowerCase() === probeSerial)
    : undefined;
  const detectedFlashSize = probe?.flashSize;
  const ramTotal = lastBuild?.ramTotal || probe?.ramSize || board?.ramSize || 0;
  const [secondaryPath, setSecondaryPath] = useState('');
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('blode:editor-tabs', { detail: { root: state?.projectRoot ?? '', paths: openFiles } }),
    );
  }, [state?.projectRoot, openFiles]);
  useEffect(() => {
    setSecondaryPath('');
  }, [state?.projectRoot]);
  useEffect(() => {
    const closed = (event: Event) => {
      const detail = (event as CustomEvent<FileClosedEvent>).detail;
      if (!detail || detail.root !== state?.projectRoot) return;
      setSecondaryPath((current) => (current === detail.path ? '' : current));
    };
    window.addEventListener('blode:file-closed', closed);
    return () => window.removeEventListener('blode:file-closed', closed);
  }, [state?.projectRoot]);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [openingVSCode, setOpeningVSCode] = useState(false);
  const openVSCode = async () => {
    if (!state?.workspaceOpen || openingVSCode || busy || studio.frozenFilePaths.size) return;
    const projectRoot = state.projectRoot;
    setOpeningVSCode(true);
    try {
      if (!(await studio.save())) return;
      await window.blode.vscodeOpen({
        expectedProjectRoot: projectRoot,
        ...(activePath && !studio.externalFiles[activePath] ? { path: activePath, ...cursor } : {}),
        confirm: true,
      });
      studio.notify(t('toast.vscodeOpened'));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(error);
      studio.notify(t(message), true);
    } finally {
      setOpeningVSCode(false);
    }
  };
  const [navigationTargets, setNavigationTargets] = useState<Partial<Record<NavigationPane, SourceLocation>>>(
    {},
  );
  const navigationOwner = useRef(studio);
  const secondaryNavigationPath = useRef(secondaryPath);
  secondaryNavigationPath.current = secondaryPath;
  navigationOwner.current = studio;
  useEffect(() => {
    setNavigationTargets({});
    const navigation = new SourceNavigation({
      snapshot: () => {
        const owner = navigationOwner.current;
        return {
          root: owner.state?.projectRoot ?? '',
          primary: owner.activePath,
          secondary: secondaryNavigationPath.current,
          active: !!owner.state?.workspaceOpen && !owner.showHome && owner.view === 'code',
        };
      },
      exists: (path) =>
        !!navigationOwner.current.state?.files.some((file) => file.path === path) ||
        !!navigationOwner.current.externalFiles[path],
      external: (id) => navigationOwner.current.loadExternalSource(id, true),
      open: (pane, path) => {
        if (pane === 'secondary') {
          navigationOwner.current.pinFile(path);
          secondaryNavigationPath.current = path;
          setSecondaryPath(path);
        } else navigationOwner.current.openFile(path);
      },
      locate: (pane, target) => setNavigationTargets((current) => ({ ...current, [pane]: target })),
      failed: (error) =>
        navigationOwner.current.notify(
          navigationOwner.current.t(error instanceof Error ? error.message : String(error)),
          true,
        ),
    });
    const navigate = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          root: string;
          target: SourceLocation;
          origin?: SourceLocation;
          pane?: NavigationPane;
        }>
      ).detail;
      if (detail?.root !== state?.projectRoot) return;
      void navigation.visit(detail.root, detail.target, detail.origin, detail.pane);
    };
    const back = (event: Event) => {
      void navigation.back((event as CustomEvent<{ pane?: NavigationPane }>).detail?.pane);
    };
    window.addEventListener('blode:navigate-source', navigate);
    window.addEventListener('blode:navigate-back', back);
    return () => {
      navigation.reset();
      window.removeEventListener('blode:navigate-source', navigate);
      window.removeEventListener('blode:navigate-back', back);
    };
  }, [state?.projectRoot]);
  const splitRegion = useRef<HTMLDivElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesTarget, setPreferencesTarget] = useState<{
    section: PreferencesSection;
    revision: number;
  }>();

  useEffect(() => {
    const openPreferences = (event: Event) => {
      const section = (event as CustomEvent<{ section?: unknown }>).detail?.section;
      const target =
        section === 'toolchain' ||
        section === 'drivers' ||
        section === 'ai' ||
        section === 'status' ||
        section === 'installation'
          ? section
          : 'general';
      setPreferencesTarget((current) => ({ section: target, revision: (current?.revision ?? 0) + 1 }));
      setPreferencesOpen(true);
    };
    window.addEventListener('blode:preferences', openPreferences);
    return () => window.removeEventListener('blode:preferences', openPreferences);
  }, []);
  useEffect(() => {
    const active = tabStrip.current?.querySelector<HTMLElement>('.editor-tab.active');
    if (!active || !tabStrip.current) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    const strip = tabStrip.current;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  }, [activePath, view, openFiles, openTools, showHome, collaboration.remoteTools.join('\0')]);

  useEffect(() => {
    if (!preferencesOpen) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPreferencesOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [preferencesOpen]);

  useEffect(() => {
    if (secondaryPath && !availableFiles.has(secondaryPath)) setSecondaryPath('');
  }, [secondaryPath, availableFiles]);

  useEffect(() => {
    // Completion sees the same unsaved drafts as the editor, so a new #define is
    // available immediately without waiting for a file save.
    setCompletionProject(
      (state?.files ?? []).map((file) => ({
        path: file.path,
        content: drafts[file.path] ?? file.content,
      })),
      {
        projectRoot: state?.projectRoot ?? '',
        cStandard: state?.build?.cStandard,
        language: state?.language,
      },
    );
    for (const file of Object.values(studio.externalFiles)) registerExternalSource(file);
  }, [
    drafts,
    state?.files,
    state?.projectRoot,
    state?.build?.cStandard,
    state?.language,
    studio.externalFiles,
  ]);
  useEffect(() => {
    if (!state?.workspaceOpen || !window.blode.languageIndex) return;
    // Saved-source cache is maintained off the typing path; buffers stay local.
    const timer = setTimeout(() => {
      void window.blode.languageIndex().catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [state?.projectRoot, state?.files]);

  const toggleSplit = () => {
    if (secondaryPath) {
      setSecondaryPath('');
      return;
    }
    const candidate = openFiles.find((path) => path !== activePath) ?? openFiles[0] ?? '';
    if (candidate) pinFile(candidate);
    setSecondaryPath(candidate);
  };
  useEffect(() => {
    window.addEventListener('blode:split-editor', toggleSplit);
    return () => window.removeEventListener('blode:split-editor', toggleSplit);
  }, [secondaryPath, openFiles, activePath]);

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
    if (state && workspaceFileView(state, path) === 'asset')
      return (
        <Suspense fallback={<div className="editor-empty">{t('editor.loading')}</div>}>
          <AssetPreview
            projectRoot={state.projectRoot}
            path={path}
            revision={state.inventory.entries
              .filter((entry) => entry.path === path)
              .map((entry) => `${entry.size}:${entry.modifiedAt ?? ''}`)
              .join('')}
          />
        </Suspense>
      );
    const external = studio.externalFiles[path];
    const file = state?.files.find((item) => item.path === path) ?? external;
    if (!file)
      return (
        <div className="editor-empty">
          <FileCode size={40} strokeWidth={1.2} aria-hidden="true" />
          <span>{t(state ? 'editor.noFile' : 'editor.loading')}</span>
        </div>
      );
    return (
      <Suspense fallback={<EditorLoading value={drafts[path] ?? file.content} />}>
        <CodeEditor
          readOnly={!!external || studio.frozenFilePaths.has(path)}
          projectRoot={state?.projectRoot ?? ''}
          path={path}
          language={file.language}
          value={drafts[path] ?? file.content}
          onCursor={primary ? (position) => setCursor(position) : undefined}
          peers={collaboration.peers}
          onPresence={collaboration.reportPresence}
          onUndo={
            !external && collaboration.enabled
              ? (direction) => collaboration.undo(path, direction)
              : undefined
          }
          primary={primary}
          navigation={
            navigationTargets[primary ? 'primary' : 'secondary']?.path === path
              ? navigationTargets[primary ? 'primary' : 'secondary']
              : undefined
          }
          onChange={(value) => {
            if (external || studio.frozenFilePaths.has(path)) return;
            if (value !== file.content) pinFile(path);
            setDrafts((current) => {
              const next = { ...current };
              if (value === file.content) delete next[path];
              else next[path] = value;
              return next;
            });
            setStale(true);
            collaboration.reportEdit(path, value);
          }}
        />
      </Suspense>
    );
  };

  return (
    <>
      <div className="editor-region">
        {(showHome || !state?.workspaceOpen) && view !== 'ai' ? (
          <WelcomeHome studio={studio} />
        ) : (
          <>
            <div
              className="editor-tabs"
              ref={tabStrip}
              onWheel={(event) => {
                const strip = event.currentTarget;
                if (strip.scrollWidth <= strip.clientWidth) return;
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                  strip.scrollLeft += event.deltaY;
                }
              }}
            >
              {fileTabs.map((file) => {
                const active = view === 'code' && activePath === file.path;
                return (
                  <div
                    className={`editor-tab ${active ? 'active' : ''} ${previewPath === file.path ? 'preview-tab' : ''} ${!openFiles.includes(file.path) ? 'remote-only-tab' : ''}`}
                    key={file.path}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        void closeTab('file', file.path);
                      }
                    }}
                  >
                    <button
                      className="tab-main"
                      onClick={() => openFile(file.path)}
                      onDoubleClick={() => pinFile(file.path)}
                      title={`${file.path}${previewPath === file.path ? ` · ${t('editor.previewHint')}` : ''}`}
                    >
                      <FileIcon name={file.path} size={14} />
                      <CollaborationAvatars path={file.path} peers={collaboration.allPeers} />
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
                      onClick={() => void closeTab('file', file.path)}
                    >
                      <X size={11} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
              {toolTabs.map((id) => {
                const tool = tools.find((item) => item.id === id);
                if (!tool) return null;
                const Icon = tool.icon;
                const active = view === tool.id;
                return (
                  <div
                    className={`editor-tab tool-tab ${active ? 'active' : ''} ${!openTools.includes(tool.id) ? 'remote-only-tab' : ''}`}
                    key={tool.id}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        void closeTab('tool', tool.id);
                      }
                    }}
                  >
                    <button className="tab-main" onClick={() => setView(tool.id)}>
                      <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
                      <CollaborationAvatars tool={tool.id} peers={collaboration.allPeers} />
                      <span className="tab-name">{t(tool.label)}</span>
                    </button>
                    <button
                      className="tab-close"
                      aria-label={t('action.close')}
                      title={t('action.close')}
                      onClick={() => void closeTab('tool', tool.id)}
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
              <EditorActions
                disabled={!state?.workspaceOpen || !!busy || studio.frozenFilePaths.size > 0}
                opening={openingVSCode}
                onOpenVSCode={openVSCode}
              />
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
                </div>
                <CollaborationStatus collaboration={collaboration} />
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
                          <ModernSelect
                            value={secondaryPath}
                            aria-label={t('action.splitEditor')}
                            onChange={(event) => {
                              pinFile(event.target.value);
                              setSecondaryPath(event.target.value);
                            }}
                          >
                            {fileTabs.map((file) => (
                              <option key={file.path} value={file.path}>
                                {file.path}
                              </option>
                            ))}
                          </ModernSelect>
                        </div>
                        <div className="monaco-container">{renderEditor(secondaryPath)}</div>
                      </div>
                    </div>
                  ) : (
                    renderEditor(activePath, true)
                  )}
                </div>
                {(workspaceFileView(state, activePath) === 'text' || !!studio.externalFiles[activePath]) && (
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
                )}
              </>
            ) : config && state ? (
              <Suspense fallback={<div className="editor-empty">{t('editor.loading')}</div>}>
                {view === 'layout' ? (
                  !layoutAvailable ? (
                    <div className="editor-empty">
                      <FileCode size={36} strokeWidth={1.2} aria-hidden="true" />
                      <p className="subtle-note">
                        {t(config.boardId === 'auto' ? 'layout.detectFirst' : 'layout.unavailable')}
                      </p>
                    </div>
                  ) : partitionEditor ? (
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
                  ) : (
                    <ResourceLayout
                      config={config}
                      baseAddress={board?.layout?.baseAddress ?? 0}
                      firmwareUsed={lastBuild?.flashUsed ?? null}
                      firmwareStale={!!state.buildStale || stale}
                      flashSizes={board?.flashSizes}
                      customFlashSize={board?.customFlashSize}
                      detectedFlashSize={detectedFlashSize}
                      busy={!!busy}
                      onResize={(flashSize) => {
                        setConfig(resizeFixedLayout(config, flashSize, flashSize !== detectedFlashSize));
                        setStale(true);
                      }}
                      onAllocate={(appSize) => {
                        setConfig(resizeAppRegion(config, appSize));
                        setStale(true);
                      }}
                      onChangePartitions={(partitions) => {
                        setConfig({ ...config, partitions });
                        setStale(true);
                      }}
                      onSave={saveConfig}
                      ramUsed={lastBuild?.ramUsed ?? null}
                      ramTotal={ramTotal}
                    />
                  )
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
                )}
              </Suspense>
            ) : (
              <div className="editor-empty">
                <FileCode size={40} strokeWidth={1.2} aria-hidden="true" />
              </div>
            )}
          </>
        )}
      </div>
      {preferencesOpen && config && state && (
        <div
          className="modal-backdrop workspace-dialog-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPreferencesOpen(false);
          }}
        >
          <div
            className="modal preferences-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('workspace.settings')}
          >
            <div className="modal-heading preferences-heading">
              <span className="modal-icon">
                <Settings2 size={17} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <h2>{t('workspace.settings')}</h2>
              <button
                className="modal-close"
                aria-label={t('action.close')}
                title={t('action.close')}
                onClick={() => setPreferencesOpen(false)}
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <Suspense fallback={<div className="editor-empty">{t('editor.loading')}</div>}>
              <Settings
                target={preferencesTarget}
                config={config}
                status={state.toolchain}
                drivers={state.drivers}
                installation={studio.installation}
                installPending={busy === 'action.install' || busy === 'action.installDriver'}
                workspaceOpen={!!state.workspaceOpen}
                onChange={setConfig}
                onSave={saveConfig}
                onInstall={install}
                onInstallDriver={installDriver}
                onRefreshDrivers={refreshDrivers}
                busy={!!busy}
                isWeb={isWeb}
                initializing={state.initializing}
              />
            </Suspense>
          </div>
        </div>
      )}
      {closeProjectPending && (
        <div className="modal-backdrop">
          <div
            className="modal close-project-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('project.close')}
          >
            <h2>{t('project.close')}</h2>
            <p>{t(studio.dirty || studio.configDirty ? 'project.saveClosePrompt' : 'project.closePrompt')}</p>
            <div className="modal-actions">
              <button onClick={() => setCloseProjectPending(false)} disabled={!!busy}>
                {t('action.cancel')}
              </button>
              <button className="primary" disabled={!!busy} onClick={() => void closeProject(true)}>
                {t('project.saveClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
