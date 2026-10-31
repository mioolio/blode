import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Check,
  Download,
  FolderOpen,
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { ComponentLibrary } from '../../shared/components';
import type { Studio } from '../workspace/useStudio';
import { pickHostPath } from '../workspace/hostPicker';
import { ComponentLibrariesModel } from './componentLibrariesModel';
import { InstallationOutput } from './InstallationOutput';
import { ModernSelect } from './ModernSelect';
import { DeviceModuleLibrary } from './DeviceModuleLibrary';
import './component-libraries.css';

type LibraryTab = 'devices' | 'installed' | 'browse' | 'import';

export default function ComponentLibrariesDialog({
  studio,
  onClose,
}: {
  studio: Studio;
  onClose: () => void;
}) {
  const { t } = studio;
  const [model] = useState(
    () =>
      new ComponentLibrariesModel(window.blode, studio.state?.workspaceOpen ? studio.state.projectRoot : ''),
  );
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const [tab, setTab] = useState<LibraryTab>('devices');
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [localSelected, setLocalSelected] = useState('');
  const [localQuery, setLocalQuery] = useState('');
  const [exportIds, setExportIds] = useState<ReadonlySet<string>>(new Set());
  const [version, setVersion] = useState('');
  const [importPath, setImportPath] = useState('');
  const [importKind, setImportKind] = useState<'directory' | 'archive'>('directory');
  const [picking, setPicking] = useState(false);
  const [remove, setRemove] = useState<ComponentLibrary>();
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const blocked = !!snapshot.operation || !!studio.busy || picking || deviceBusy;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const currentProject = studio.state?.workspaceOpen ? studio.state.projectRoot : '';
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  const projectAvailable =
    !!model.projectRoot &&
    snapshot.data?.projectRoot === model.projectRoot &&
    currentProject === model.projectRoot;
  const selectedLibrary =
    snapshot.search?.entries.find((entry) => entry.name === selected) ?? snapshot.search?.entries[0];
  const installed = snapshot.data?.components ?? [];
  const localLibrary = installed.find((library) => library.id === localSelected) ?? installed[0];
  const localLibraries = installed.filter((library) =>
    `${library.name} ${library.path}`.toLowerCase().includes(localQuery.trim().toLowerCase()),
  );
  const installedLibrary = installed.find(
    (library) => library.name.toLowerCase() === selectedLibrary?.name.toLowerCase(),
  );
  const selectedExportIds = [...exportIds].filter((id) => installed.some((library) => library.id === id));
  const selectedVersion = selectedLibrary?.versions.includes(version)
    ? version
    : (selectedLibrary?.latestVersion ?? '');

  useEffect(() => {
    model.activate();
    const unsubscribe = window.blode.onEvent((event) => model.receive(event));
    return () => {
      model.dispose();
      unsubscribe();
    };
  }, [model]);
  useEffect(() => {
    if (tab !== 'devices' && !snapshot.data && !snapshot.loading && model.projectRoot) void model.load();
  }, [tab, model]);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>('.component-close')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('.host-picker-backdrop')) return;
      if (event.key === 'Escape' && !blockedRef.current) {
        if (root.current?.querySelector('.device-module-review')) return;
        event.preventDefault();
        close.current();
      }
      if (event.key === 'Tab') {
        const scope = root.current?.querySelector('.device-module-review') ?? root.current;
        const elements = [
          ...(scope?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"], a[href]',
          ) ?? []),
        ].filter((element) => element.getClientRects().length && !element.closest('[aria-hidden="true"]'));
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const run = (label: string, action: () => Promise<boolean>) => {
    if (blocked || !projectAvailable) return;
    void studio.perform(label, async () => {
      if (await action()) {
        setRemove(undefined);
        await studio.refresh();
      }
    });
  };
  const browseHost = async (kind: 'directory' | 'archive') => {
    if (blocked) return;
    setPicking(true);
    try {
      const path = await pickHostPath({
        kind: kind === 'directory' ? 'directory' : 'file',
        title: t(kind === 'directory' ? 'components.pickDirectory' : 'components.pickArchive'),
        ...(kind === 'archive' ? { extensions: ['zip'] } : {}),
      });
      if (path && model.active && currentProjectRef.current === model.projectRoot) {
        setImportKind(kind);
        setImportPath(path);
      }
    } finally {
      if (model.active) setPicking(false);
    }
  };
  const exportLibraries = async (ids?: string[]) => {
    if (blocked || !projectAvailable || !(await studio.save())) return;
    if (!model.active || currentProjectRef.current !== model.projectRoot) return;
    await studio.perform('components.export', async () => {
      if (await model.export(ids)) studio.notify(t('components.exported'));
    });
  };
  const dependencies = (names: string[] | undefined) =>
    !!names?.length && (
      <div className="component-dependencies">
        <span>{t('components.dependencies')}</span>
        <ul>
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </div>
    );

  return (
    <div className="modal-backdrop workspace-dialog-backdrop">
      <section
        className="modal component-libraries-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="component-libraries-title"
        ref={root}
      >
        <header className="component-heading">
          <h2 id="component-libraries-title">
            <Package size={18} />
            {t('components.title')}
          </h2>
          <button
            className="icon-button"
            hidden={tab === 'devices'}
            disabled={blocked || snapshot.loading || !model.projectRoot}
            aria-label={t('action.refresh')}
            title={t('action.refresh')}
            onClick={() => void model.load()}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="icon-button component-close"
            disabled={blocked}
            aria-label={t('action.close')}
            title={t('action.close')}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <nav className="component-tabs" aria-label={t('components.title')}>
          {(['devices', 'installed', 'browse', 'import'] as const).map((item) => (
            <button
              key={item}
              className={tab === item ? 'active' : ''}
              disabled={blocked}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {t(`components.${item}`)}{' '}
              {item === 'installed' && <span className="count-badge">{installed.length}</span>}
            </button>
          ))}
        </nav>
        {tab !== 'devices' && (snapshot.error || snapshot.completed) && (
          <div
            className={`component-notice${snapshot.error ? ' error-text' : ''}`}
            role={snapshot.error ? 'alert' : 'status'}
          >
            {t(
              snapshot.error || (snapshot.operation === 'export' ? 'components.exported' : 'components.done'),
            )}
          </div>
        )}
        <div className={`component-content component-page-${tab}`}>
          {tab === 'devices' && <DeviceModuleLibrary studio={studio} onBusyChange={setDeviceBusy} />}
          {tab === 'installed' && (
            <>
              <div className="component-toolbar">
                <div className="component-filter">
                  <Search size={14} />
                  <input
                    value={localQuery}
                    placeholder={t('components.filterInstalled')}
                    aria-label={t('components.filterInstalled')}
                    onChange={(event) => setLocalQuery(event.target.value)}
                  />
                </div>
                <button
                  disabled={blocked || !projectAvailable || !installed.length}
                  onClick={() => void exportLibraries(selectedExportIds)}
                >
                  <Upload size={14} />
                  {t(selectedExportIds.length ? 'components.exportSelected' : 'components.exportAll')}
                  {selectedExportIds.length > 0 && (
                    <span className="count-badge">{selectedExportIds.length}</span>
                  )}
                </button>
              </div>
              {!model.projectRoot ? (
                <p className="component-empty">{t('components.noProject')}</p>
              ) : snapshot.loading ? (
                <p className="component-message" role="status">
                  <LoaderCircle size={14} className="spin" />
                  {t('components.loading')}
                </p>
              ) : !installed.length ? (
                <div className="component-empty-state">
                  <Package size={30} strokeWidth={1.2} />
                  <p>{t('components.empty')}</p>
                  <div>
                    <button onClick={() => setTab('browse')}>{t('components.browse')}</button>
                    <button onClick={() => setTab('import')}>{t('components.import')}</button>
                  </div>
                </div>
              ) : (
                <div className="component-catalog">
                  <div
                    className="component-results component-installed-results"
                    aria-label={t('components.installed')}
                  >
                    {localLibraries.map((library) => (
                      <div
                        className={`component-installed-row${localLibrary?.id === library.id ? ' active' : ''}`}
                        key={library.id}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${t('components.selectExport')} ${library.name}`}
                          checked={exportIds.has(library.id)}
                          onChange={(event) =>
                            setExportIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(library.id);
                              else next.delete(library.id);
                              return next;
                            })
                          }
                        />
                        <button
                          aria-pressed={localLibrary?.id === library.id}
                          onClick={() => {
                            setLocalSelected(library.id);
                            setRemove(undefined);
                          }}
                        >
                          <strong>{library.name}</strong>
                          <small>{library.kind === 'arduino' ? 'Arduino' : 'C/C++'}</small>
                          <span>{library.version}</span>
                        </button>
                      </div>
                    ))}
                    {!localLibraries.length && <p className="component-empty">{t('components.noResults')}</p>}
                  </div>
                  <section className="component-detail">
                    {localLibrary && (
                      <>
                        <div className="component-detail-title">
                          <Package size={24} strokeWidth={1.3} />
                          <div>
                            <h3>{localLibrary.name}</h3>
                            <span>{localLibrary.version || 'C/C++'}</span>
                          </div>
                          <span className="component-installed-badge">
                            <Check size={12} />
                            {t('components.installed')}
                          </span>
                        </div>
                        <dl className="component-facts">
                          <div>
                            <dt>{t('components.source')}</dt>
                            <dd>{t(`components.source.${localLibrary.source.type}`)}</dd>
                          </div>
                          <div>
                            <dt>{t('components.path')}</dt>
                            <dd>
                              <code>{localLibrary.path}</code>
                            </dd>
                          </div>
                        </dl>
                        {dependencies(localLibrary.dependencies)}
                        {!!localLibrary.includes.length && (
                          <div className="component-detail-section">
                            <h4>{t('components.includeDirectories')}</h4>
                            {localLibrary.includes.map((directory) => (
                              <code key={directory}>{directory}</code>
                            ))}
                          </div>
                        )}
                        <div className="component-detail-section">
                          <h4>
                            {t('components.sourceFiles')} <span>{localLibrary.sources.length}</span>
                          </h4>
                          <div className="component-source-list">
                            {localLibrary.sources.map((source) => (
                              <code key={source}>{source}</code>
                            ))}
                          </div>
                        </div>
                        <div className="component-detail-actions">
                          <button
                            disabled={blocked || !projectAvailable}
                            onClick={() => void exportLibraries([localLibrary.id])}
                          >
                            <Upload size={14} />
                            {t('components.export')}
                          </button>
                          <button
                            className="component-remove"
                            disabled={blocked || !projectAvailable}
                            onClick={() => setRemove(localLibrary)}
                          >
                            <Trash2 size={14} />
                            {t('components.remove')}
                          </button>
                        </div>
                        {remove?.id === localLibrary.id && (
                          <div className="component-confirm" role="alert">
                            <span>
                              {t('components.removeConfirm')} {localLibrary.name}
                            </span>
                            <button disabled={blocked} onClick={() => setRemove(undefined)}>
                              {t('action.cancel')}
                            </button>
                            <button
                              className="danger"
                              disabled={blocked}
                              onClick={() => run('components.remove', () => model.remove(localLibrary.id))}
                            >
                              {t('components.remove')}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </section>
                </div>
              )}
              {!!snapshot.data?.provided.length && (
                <details className="component-provided">
                  <summary>
                    {t('components.provided')} <span>{snapshot.data.provided.length}</span>
                  </summary>
                  {snapshot.data.provided.map((library) => (
                    <div key={library.path}>
                      <strong>{library.name}</strong>
                      <span>{library.version}</span>
                      <code title={library.path}>{library.path}</code>
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          {tab === 'browse' && (
            <>
              <form
                className="component-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSelected('');
                  setVersion('');
                  void model.search();
                }}
              >
                <div className="component-filter">
                  <Search size={14} />
                  <input
                    aria-label={t('components.searchPlaceholder')}
                    placeholder={t('components.searchPlaceholder')}
                    value={snapshot.query}
                    maxLength={200}
                    disabled={!!snapshot.operation}
                    onChange={(event) => {
                      model.setQuery(event.target.value);
                      setSelected('');
                    }}
                  />
                </div>
                <button
                  type="submit"
                  className="primary"
                  disabled={blocked || snapshot.searching || !snapshot.query.trim()}
                >
                  {snapshot.searching ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}{' '}
                  {t('components.search')}
                </button>
              </form>
              {snapshot.searching && (
                <p className="component-message" role="status">
                  {t('components.loading')}
                </p>
              )}
              {!snapshot.search && !snapshot.searching && (
                <div className="component-empty-state">
                  <Search size={30} strokeWidth={1.2} />
                  <p>{t('components.searchIdle')}</p>
                </div>
              )}
              {snapshot.search && !snapshot.search.entries.length && (
                <p className="component-empty">{t('components.noResults')}</p>
              )}
              {!!snapshot.search?.entries.length && (
                <div className="component-catalog">
                  <div className="component-results" aria-label={t('components.browse')}>
                    {snapshot.search.entries.map((library) => (
                      <button
                        key={library.name}
                        className={selectedLibrary?.name === library.name ? 'active' : ''}
                        aria-pressed={selectedLibrary?.name === library.name}
                        onClick={() => {
                          setSelected(library.name);
                          setVersion(library.latestVersion);
                        }}
                      >
                        <strong>{library.name}</strong>
                        <small>{library.author}</small>
                        <span>
                          {installed.some((item) => item.name.toLowerCase() === library.name.toLowerCase())
                            ? t('components.installed')
                            : library.latestVersion}
                        </span>
                      </button>
                    ))}
                  </div>
                  <section className="component-detail">
                    {selectedLibrary && (
                      <>
                        <div className="component-detail-title">
                          <Package size={24} strokeWidth={1.3} />
                          <div>
                            <h3>{selectedLibrary.name}</h3>
                            {selectedLibrary.author && <span>{selectedLibrary.author}</span>}
                          </div>
                          {installedLibrary && (
                            <span className="component-installed-badge">
                              <Check size={12} />
                              {installedLibrary.version}
                            </span>
                          )}
                        </div>
                        {selectedLibrary.description && (
                          <p className="component-description">{selectedLibrary.description}</p>
                        )}
                        <label>
                          {t('components.version')}
                          <ModernSelect
                            value={selectedVersion}
                            disabled={blocked}
                            onChange={(event) => setVersion(event.target.value)}
                          >
                            {selectedLibrary.versions.map((item) => (
                              <option key={item} value={item}>
                                {item}
                              </option>
                            ))}
                          </ModernSelect>
                        </label>
                        {dependencies(
                          selectedLibrary.dependenciesByVersion?.[selectedVersion] ??
                            (selectedVersion === selectedLibrary.latestVersion
                              ? selectedLibrary.dependencies
                              : undefined),
                        )}
                        {!projectAvailable && (
                          <p className="component-message">{t('components.noProject')}</p>
                        )}
                        <div className="component-detail-actions">
                          {installedLibrary ? (
                            <button
                              onClick={() => {
                                setLocalSelected(installedLibrary.id);
                                setTab('installed');
                              }}
                            >
                              {t('components.manageInstalled')}
                            </button>
                          ) : (
                            <button
                              className="primary"
                              disabled={blocked || !projectAvailable || !selectedVersion}
                              onClick={() =>
                                run('components.install', () =>
                                  model.install(selectedLibrary.name, selectedVersion),
                                )
                              }
                            >
                              <Download size={14} />
                              {t('components.install')}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </section>
                </div>
              )}
              {snapshot.search?.truncated && <p className="component-message">{t('components.truncated')}</p>}
            </>
          )}
          {tab === 'import' && (
            <form
              className="component-import"
              onSubmit={(event) => {
                event.preventDefault();
                run('components.importAction', () => model.import(importPath.trim(), importKind));
              }}
            >
              <Package size={32} strokeWidth={1.2} />
              <h3>{t('components.import')}</h3>
              {!model.projectRoot && <p className="component-message">{t('components.noProject')}</p>}
              <label>
                {t('components.source')}
                <ModernSelect
                  value={importKind}
                  disabled={blocked}
                  onChange={(event) => setImportKind(event.target.value as 'directory' | 'archive')}
                >
                  <option value="directory">{t('components.source.directory')}</option>
                  <option value="archive">{t('components.source.archive')}</option>
                </ModernSelect>
              </label>
              <label>
                {t('components.path')}
                <div className="component-import-path">
                  <input
                    value={importPath}
                    disabled={blocked || !projectAvailable}
                    spellCheck={false}
                    onChange={(event) => setImportPath(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={blocked || !projectAvailable}
                    onClick={() => void browseHost(importKind)}
                    aria-label={t(
                      importKind === 'directory' ? 'components.pickDirectory' : 'components.pickArchive',
                    )}
                  >
                    <FolderOpen size={15} />
                  </button>
                </div>
              </label>
              <div className="component-import-actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={blocked || !projectAvailable || !importPath.trim()}
                >
                  <Download size={14} />
                  {t('components.importAction')}
                </button>
              </div>
            </form>
          )}
        </div>
        {(snapshot.installation || (snapshot.operation && snapshot.operation !== 'export')) && (
          <details className="component-install-output" open={!!snapshot.operation}>
            <summary>
              {t(snapshot.operation ? 'components.operationProgress' : 'settings.installOutput')}
            </summary>
            <InstallationOutput installation={snapshot.installation} pending={!!snapshot.operation} />
          </details>
        )}
      </section>
    </div>
  );
}
