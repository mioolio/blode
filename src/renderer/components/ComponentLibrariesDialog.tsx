import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, FolderOpen, LoaderCircle, Package, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { ComponentLibrary } from '../../shared/components';
import type { Studio } from '../workspace/useStudio';
import { pickHostPath } from '../workspace/hostPicker';
import { ComponentLibrariesModel } from './componentLibrariesModel';
import { InstallationOutput } from './InstallationOutput';
import { ModernSelect } from './ModernSelect';
import './component-libraries.css';

type LibraryTab = 'installed' | 'browse' | 'import';

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
  const [tab, setTab] = useState<LibraryTab>('installed');
  const [selected, setSelected] = useState('');
  const [version, setVersion] = useState('');
  const [importPath, setImportPath] = useState('');
  const [importKind, setImportKind] = useState<'directory' | 'archive'>('directory');
  const [picking, setPicking] = useState(false);
  const [remove, setRemove] = useState<ComponentLibrary>();
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const blocked = !!snapshot.operation || !!studio.busy || picking;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const currentProject = studio.state?.workspaceOpen ? studio.state.projectRoot : '';
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  const projectAvailable =
    !!model.projectRoot &&
    snapshot.data?.projectRoot === model.projectRoot &&
    currentProject === model.projectRoot;
  const selectedLibrary = snapshot.search?.entries.find((entry) => entry.name === selected);
  const selectedVersion = selectedLibrary?.versions.includes(version)
    ? version
    : (selectedLibrary?.latestVersion ?? '');

  useEffect(() => {
    model.activate();
    const unsubscribe = window.blode.onEvent((event) => model.receive(event));
    void model.load();
    return () => {
      model.dispose();
      unsubscribe();
    };
  }, [model]);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>('.component-close')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('.host-picker-backdrop')) return;
      if (event.key === 'Escape' && !blockedRef.current) {
        event.preventDefault();
        close.current();
      }
      if (event.key === 'Tab') {
        const elements = [
          ...(root.current?.querySelectorAll<HTMLElement>(
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
        {model.projectRoot && (
          <div className="component-project" title={model.projectRoot}>
            {model.projectRoot}
          </div>
        )}
        <nav className="component-tabs" aria-label={t('components.title')}>
          {(['installed', 'browse', 'import'] as const).map((item) => (
            <button
              key={item}
              className={tab === item ? 'active' : ''}
              aria-pressed={tab === item}
              onClick={() => setTab(item)}
            >
              {t(`components.${item}`)}
            </button>
          ))}
        </nav>
        <div className="component-content">
          {snapshot.error && (
            <pre role="alert" className="component-error error-text">
              {t(snapshot.error)}
            </pre>
          )}
          {snapshot.completed && !snapshot.error && (
            <p role="status" className="component-message">
              {t('components.done')}
            </p>
          )}
          {tab === 'installed' && (
            <>
              {snapshot.loading && (
                <p role="status" className="component-message">
                  <LoaderCircle size={14} className="spin" />
                  {t('components.loading')}
                </p>
              )}
              {!model.projectRoot ? (
                <p className="component-empty">{t('components.noProject')}</p>
              ) : (
                !snapshot.loading &&
                snapshot.data &&
                !snapshot.data.components.length && <p className="component-empty">{t('components.empty')}</p>
              )}
              <div className="component-installed-list">
                {snapshot.data?.components.map((library) => (
                  <article className="component-library" key={library.id}>
                    <div className="component-library-heading">
                      <h3>{library.name}</h3>
                      <span>{library.version}</span>
                      <small>{library.kind === 'arduino' ? 'Arduino' : 'C/C++'}</small>
                      <button
                        className="icon-button"
                        disabled={blocked || !projectAvailable}
                        title={t('components.remove')}
                        aria-label={`${t('components.remove')} ${library.name}`}
                        onClick={() => setRemove(library)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p className="component-origin">
                      {t(`components.source.${library.source.type}`)} <code>{library.path}</code>
                    </p>
                    {dependencies(library.dependencies)}
                    {remove?.id === library.id && (
                      <div className="component-confirm" role="alert">
                        <span>
                          {t('components.removeConfirm')} {library.name}
                        </span>
                        <button disabled={blocked} onClick={() => setRemove(undefined)}>
                          {t('action.cancel')}
                        </button>
                        <button
                          disabled={blocked}
                          onClick={() => run('components.remove', () => model.remove(library.id))}
                        >
                          {t('components.remove')}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {!!snapshot.data?.provided.length && (
                <details className="component-provided">
                  <summary>
                    {t('components.provided')} ({snapshot.data.provided.length})
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
                <button
                  type="submit"
                  className="primary"
                  disabled={blocked || snapshot.searching || !snapshot.query.trim()}
                >
                  {snapshot.searching ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
                  {t('components.search')}
                </button>
              </form>
              {snapshot.searching && (
                <p role="status" className="component-message">
                  {t('components.loading')}
                </p>
              )}
              {!snapshot.search && !snapshot.searching && (
                <p className="component-empty">{t('components.searchIdle')}</p>
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
                        className={selected === library.name ? 'active' : ''}
                        aria-pressed={selected === library.name}
                        onClick={() => {
                          setSelected(library.name);
                          setVersion(library.latestVersion);
                        }}
                      >
                        <strong>{library.name}</strong>
                        <small>{library.author}</small>
                        <span>{library.latestVersion}</span>
                      </button>
                    ))}
                  </div>
                  <section className="component-detail">
                    {selectedLibrary ? (
                      <>
                        <h3>{selectedLibrary.name}</h3>
                        {selectedLibrary.author && (
                          <p>
                            {t('components.author')}: {selectedLibrary.author}
                          </p>
                        )}
                        {selectedLibrary.description && <p>{selectedLibrary.description}</p>}
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
                      </>
                    ) : (
                      <p className="component-empty">{t('components.selectLibrary')}</p>
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
                <input
                  value={importPath}
                  disabled={blocked || !projectAvailable}
                  spellCheck={false}
                  onChange={(event) => setImportPath(event.target.value)}
                />
              </label>
              <div className="component-import-actions">
                <button
                  type="button"
                  disabled={blocked || !projectAvailable}
                  onClick={() => void browseHost('directory')}
                >
                  <FolderOpen size={14} />
                  {t('components.pickDirectory')}
                </button>
                <button
                  type="button"
                  disabled={blocked || !projectAvailable}
                  onClick={() => void browseHost('archive')}
                >
                  <Package size={14} />
                  {t('components.pickArchive')}
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={blocked || !projectAvailable || !importPath.trim()}
                >
                  {t('components.importAction')}
                </button>
              </div>
            </form>
          )}
          {(snapshot.installation || snapshot.operation) && (
            <section className="component-install-output">
              <InstallationOutput installation={snapshot.installation} pending={!!snapshot.operation} />
            </section>
          )}
        </div>
      </section>
    </div>
  );
}
