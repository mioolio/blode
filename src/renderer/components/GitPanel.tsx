import { ModernSelect } from './ModernSelect';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, GitBranch, Minus, Plus, RefreshCw, Save, Upload, X } from 'lucide-react';
import type { GitActionRequest, GitApi, GitFileStatus } from '../../shared/git';
import { useI18n } from '../i18n';
import { cacheGitStatus, useGitStatus } from '../workspace/useGitStatus';
import './git-panel.css';
import type { Studio } from '../workspace/useStudio';

/** Native and browser workbenches operate on the target host's Git repository. */
export function GitPanel({ studio }: { studio: Studio }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [root, setRoot] = useState('');
  const { state, error: statusError, refresh } = useGitStatus(open ? root : '');
  const [tab, setTab] = useState<'changes' | 'branches' | 'remotes' | 'identity' | 'management'>('changes');
  const [managementMode, setManagementMode] = useState<'isolated' | 'shared'>('isolated');
  const [removeTarget, setRemoveTarget] = useState<'isolated' | 'shared' | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState('');
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [failed, setFailed] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState(''),
    [branch, setBranch] = useState(''),
    [newBranch, setNewBranch] = useState('');
  const [remote, setRemote] = useState(''),
    [remoteName, setRemoteName] = useState('origin'),
    [remoteUrl, setRemoteUrl] = useState('');
  const [name, setName] = useState(''),
    [email, setEmail] = useState('');
  const [diff, setDiff] = useState(''),
    [selected, setSelected] = useState('');
  const diffRevision = useRef(0);
  const [output, setOutput] = useState('');
  const git = window.blode as typeof window.blode & Partial<GitApi>;
  const explain = (error: unknown) =>
    t(
      (error instanceof Error ? error.message : String(error)).replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      ),
    );
  useEffect(() => {
    const show = () => {
      setOpen(true);
      setNotice('');
      setFailed(false);
      void window.blode
        .getState()
        .then((next) => {
          setRoot(next.projectRoot);
          if (!next.projectRoot) {
            setNotice(t('error.noWorkspace'));
            setFailed(true);
          }
        })
        .catch((error) => {
          setNotice(explain(error));
          setFailed(true);
        });
    };
    window.addEventListener('blode:git', show);
    return () => window.removeEventListener('blode:git', show);
  }, [t]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) setOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  useEffect(() => {
    setBranch(state?.branch ?? '');
    setName(state?.identity.name ?? '');
    setEmail(state?.identity.email ?? '');
  }, [state?.projectRoot, state?.branch, state?.identity.name, state?.identity.email]);
  useEffect(() => {
    setManagementMode(state?.mode === 'shared' ? 'shared' : 'isolated');
    setRemoveTarget(null);
    setRemoveConfirmation('');
  }, [state?.projectRoot, state?.mode]);
  useEffect(() => {
    if (!state) return;
    setRemote((current) =>
      state.remotes.some((item) => item.name === current) ? current : (state.remotes[0]?.name ?? ''),
    );
  }, [state?.remotes]);
  useEffect(() => {
    const selected = state?.remotes.find((item) => item.name === remote);
    if (selected) {
      setRemoteName(selected.name);
      setRemoteUrl(selected.fetchUrl);
    }
  }, [remote, state?.projectRoot]);
  useEffect(() => {
    if (!open) return;
    return window.blode.onEvent((event) => {
      if (['status.projectOpened', 'status.projectClosed'].includes(event.message))
        void window.blode
          .getState()
          .then((next) => setRoot(next.projectRoot))
          .catch(() => {});
    });
  }, [open]);
  const act = async (request: GitActionRequest) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    setFailed(false);
    try {
      if (!git.gitAction) throw new Error('git.bridgeUnavailable');
      if (['stage', 'commit', 'checkout', 'pull', 'createBranch'].includes(request.action)) {
        if (!(await studio.save())) throw new Error('toast.saveFirst');
      }
      const result = await git.gitAction(request);
      cacheGitStatus(result.status);
      setOutput(result.output);
      diffRevision.current++;
      setDiff('');
      setSelected('');
      setNotice(t('git.completed'));
      if (request.action === 'commit') setMessage('');
      if (request.action === 'createBranch') setNewBranch('');
      if (request.action === 'removeRepository') setRemoveTarget(null);
    } catch (error) {
      setFailed(true);
      setNotice(explain(error));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const inspect = async (file: GitFileStatus, staged: boolean) => {
    const revision = ++diffRevision.current;
    setSelected(`${file.path}${staged ? ' · index' : ''}`);
    setDiff('');
    try {
      if (!git.gitDiff) throw new Error('git.bridgeUnavailable');
      const text = await git.gitDiff({ path: file.path, staged });
      if (revision === diffRevision.current) setDiff(t(text));
    } catch (error) {
      if (revision === diffRevision.current) {
        setNotice(explain(error));
        setFailed(true);
      }
    }
  };
  if (!open) return null;
  const files = state?.files ?? [],
    unstaged = files.filter((file) => file.unstaged),
    staged = files.filter((file) => file.staged);
  const chooseRemote = (value: string) => {
    setRemote(value);
    const found = state?.remotes.find((item) => item.name === value);
    if (found) {
      setRemoteName(found.name);
      setRemoteUrl(found.fetchUrl);
    }
  };
  const group = (items: GitFileStatus[], indexed: boolean) => (
    <section className={`git-change-group${items.length ? ' has-files' : ''}`}>
      <header>
        <h3>
          {t(indexed ? 'git.staged' : 'git.unstaged')} <span>{items.length}</span>
        </h3>
        <button
          disabled={busy || !items.length}
          onClick={() =>
            void act({ action: indexed ? 'unstage' : 'stage', paths: items.map((file) => file.path) })
          }
        >
          {indexed ? <Minus size={13} /> : <Plus size={13} />}{' '}
          {t(indexed ? 'git.unstageAll' : 'git.stageAll')}
        </button>
      </header>
      {items.length ? (
        <div className="git-change-files">
          {items.map((file) => (
            <div className="git-change-row" key={file.path}>
              <button className="git-file" onClick={() => void inspect(file, indexed)} title={file.path}>
                <span className={`git-file-code code-${file.code}`}>{file.code}</span>
                <span>{file.path}</span>
              </button>
              <button
                className="icon-button"
                title={t(indexed ? 'git.unstage' : 'git.stage')}
                aria-label={`${t(indexed ? 'git.unstage' : 'git.stage')} ${file.path}`}
                disabled={busy}
                onClick={() => void act({ action: indexed ? 'unstage' : 'stage', paths: [file.path] })}
              >
                {indexed ? <Minus size={14} /> : <Plus size={14} />}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="subtle-note">{t('git.noChanges')}</p>
      )}
    </section>
  );
  const management = (
    <div className="git-form git-management">
      <p>{t(`git.mode.${state?.mode ?? 'disabled'}`)}</p>
      <label>
        {t('git.managementMode')}
        <ModernSelect
          value={managementMode}
          disabled={busy}
          onChange={(event) => setManagementMode(event.target.value as 'isolated' | 'shared')}
        >
          <option value="isolated">{t('git.mode.isolated')}</option>
          <option value="shared" disabled={!state?.sharedAvailable}>
            {t('git.mode.shared')}
          </option>
        </ModernSelect>
      </label>
      <div className="git-network-actions">
        <button
          className="primary"
          disabled={busy || (state?.repository && managementMode === state.mode)}
          onClick={() =>
            void act(
              managementMode === 'isolated' && !state?.ownedHistory
                ? { action: 'init' }
                : { action: 'setMode', mode: managementMode, confirm: true },
            )
          }
        >
          {t('git.enableManagement')}
        </button>
        {state?.repository && (
          <button
            disabled={busy}
            onClick={() => void act({ action: 'setMode', mode: 'disabled', confirm: true })}
          >
            {t('git.disableManagement')}
          </button>
        )}
      </div>
      {(state?.ownedHistory || state?.mode === 'shared') && (
        <div className="git-management-removal">
          {state.ownedHistory && (
            <button
              disabled={busy}
              onClick={() => {
                setRemoveTarget('isolated');
                setRemoveConfirmation('');
              }}
            >
              {t('git.removeIsolated')}
            </button>
          )}
          {state.mode === 'shared' && (
            <button
              disabled={busy}
              onClick={() => {
                setRemoveTarget('shared');
                setRemoveConfirmation('');
              }}
            >
              {t('git.removeShared')}
            </button>
          )}
        </div>
      )}
      {removeTarget && (
        <section className="git-removal-confirmation" role="alertdialog" aria-labelledby="git-removal-title">
          <h3 id="git-removal-title">
            {t(removeTarget === 'isolated' ? 'git.removeIsolated' : 'git.removeShared')}
          </h3>
          <p>{t(removeTarget === 'isolated' ? 'git.removeIsolatedConfirm' : 'git.removeSharedConfirm')}</p>
          <code>{removeTarget === 'isolated' ? `${root}/.blode/git` : `${state?.repositoryRoot}/.git`}</code>
          {removeTarget === 'shared' && (
            <label>
              {t('git.typeRepositoryRoot')}
              <input
                value={removeConfirmation}
                onChange={(event) => setRemoveConfirmation(event.target.value)}
                placeholder={state?.repositoryRoot}
              />
            </label>
          )}
          <div className="git-network-actions">
            <button disabled={busy} onClick={() => setRemoveTarget(null)}>
              {t('action.cancel')}
            </button>
            <button
              className="danger"
              disabled={busy || (removeTarget === 'shared' && removeConfirmation !== state?.repositoryRoot)}
              onClick={() =>
                void act({
                  action: 'removeRepository',
                  target: removeTarget,
                  ...(removeTarget === 'shared' ? { repositoryRoot: removeConfirmation } : {}),
                  confirm: true,
                })
              }
            >
              {t('git.confirmRemove')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
  return (
    <div className="modal-backdrop workspace-dialog-backdrop">
      <section className="modal git-modal" role="dialog" aria-modal="true" aria-labelledby="git-dialog-title">
        <header className="git-heading">
          <h2 id="git-dialog-title">
            <GitBranch size={17} />
            {t('git.title')}
          </h2>
          <button
            className="icon-button"
            disabled={busy}
            title={t('action.refresh')}
            aria-label={t('action.refresh')}
            onClick={() =>
              void refresh().catch((error) => {
                setNotice(explain(error));
                setFailed(true);
              })
            }
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="modal-close"
            disabled={busy}
            title={t('window.close')}
            aria-label={t('window.close')}
            onClick={() => setOpen(false)}
          >
            <X size={16} />
          </button>
        </header>
        <div className="git-root">
          <span title={state?.repositoryRoot || root}>
            {state?.repositoryRoot || root || t('welcome.noWorkspace')}
          </span>
          {state?.repository && (
            <strong>
              {state.branch || t('git.detached')} {state.upstream ? `→ ${state.upstream}` : ''} ↑{state.ahead}{' '}
              ↓{state.behind}
            </strong>
          )}
        </div>
        {(notice || statusError) && (
          <div
            className={`git-notice ${failed || statusError ? 'error-text' : ''}`}
            role={failed || statusError ? 'alert' : 'status'}
          >
            {notice || explain(statusError)}
          </div>
        )}
        {state && state.mode === undefined ? (
          <div className="git-empty">{t('git.bridgeUnavailable')}</div>
        ) : state && !state.available ? (
          <div className="git-empty">{t('git.missingHint')}</div>
        ) : state && !state.repository ? (
          <div className="git-empty">
            <p>{t('git.notRepository')}</p>
            {management}
          </div>
        ) : state?.repository ? (
          <>
            <nav className="git-navigation" aria-label={t('git.title')}>
              {(['changes', 'branches', 'remotes', 'identity', 'management'] as const).map((id) => (
                <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>
                  {t(`git.tab.${id}`)}
                </button>
              ))}
            </nav>
            <div className="git-content">
              {tab === 'management' && management}
              {tab === 'changes' && (
                <>
                  {!!state.outsideChanges && (
                    <p className="git-warning">
                      {t('git.outsideChanges')} {state.outsideChanges}
                    </p>
                  )}
                  <div className="git-changes-grid">
                    <div className="git-change-list">
                      {group(unstaged, false)}
                      {group(staged, true)}
                      <label>
                        {t('git.commitMessage')}
                        <textarea
                          rows={3}
                          value={message}
                          disabled={busy}
                          onChange={(event) => setMessage(event.target.value)}
                        />
                      </label>
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          !message.trim() ||
                          !staged.length ||
                          !!state.outsideStaged ||
                          files.some((file) => file.conflicted)
                        }
                        onClick={() => void act({ action: 'commit', message, confirm: true })}
                      >
                        <Check size={14} />
                        {t('git.commit')}
                      </button>
                    </div>
                    <section className="git-diff">
                      <h3>{selected || t('git.diff')}</h3>
                      <pre>{diff || t('git.selectDiff')}</pre>
                    </section>
                  </div>
                </>
              )}
              {tab === 'branches' && (
                <div className="git-form">
                  <label>
                    {t('git.currentBranch')}
                    <ModernSelect
                      value={branch}
                      disabled={busy}
                      onChange={(event) => setBranch(event.target.value)}
                    >
                      <option value="">{t('git.selectBranch')}</option>
                      {state.branches.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </ModernSelect>
                  </label>
                  <button
                    disabled={busy || !branch || branch === state.branch}
                    onClick={() => void act({ action: 'checkout', branch })}
                  >
                    {t('git.checkout')}
                  </button>
                  <label>
                    {t('git.newBranch')}
                    <input
                      value={newBranch}
                      disabled={busy}
                      onChange={(event) => setNewBranch(event.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !newBranch.trim()}
                    onClick={() => void act({ action: 'createBranch', branch: newBranch.trim() })}
                  >
                    <Plus size={14} />
                    {t('git.createBranch')}
                  </button>
                  <p className="subtle-note">{t('git.branchNote')}</p>
                </div>
              )}
              {tab === 'remotes' && (
                <div className="git-form">
                  <label>
                    {t('git.remote')}
                    <ModernSelect
                      value={remote}
                      disabled={busy}
                      onChange={(event) => chooseRemote(event.target.value)}
                    >
                      <option value="">{t('git.selectRemote')}</option>
                      {state.remotes.map((item) => (
                        <option key={item.name}>{item.name}</option>
                      ))}
                    </ModernSelect>
                  </label>
                  <div className="git-network-actions">
                    <button disabled={busy || !remote} onClick={() => void act({ action: 'fetch', remote })}>
                      <Download size={14} />
                      {t('git.fetch')}
                    </button>
                    <button
                      disabled={busy || !remote || !state.branch}
                      onClick={() =>
                        void act({ action: 'pull', remote, branch: state.branch, confirm: true })
                      }
                    >
                      <Download size={14} />
                      {t('git.pull')}
                    </button>
                    <button
                      className="primary"
                      disabled={busy || !remote || !state.branch}
                      onClick={() =>
                        void act({ action: 'push', remote, branch: state.branch, confirm: true })
                      }
                    >
                      <Upload size={14} />
                      {t('git.push')}
                    </button>
                  </div>
                  <p className="subtle-note">{t('git.remoteNote')}</p>
                  <label>
                    {t('git.remoteName')}
                    <input
                      value={remoteName}
                      disabled={busy}
                      onChange={(event) => setRemoteName(event.target.value)}
                    />
                  </label>
                  <label>
                    {t('git.remoteUrl')}
                    <input
                      value={remoteUrl}
                      disabled={busy}
                      placeholder="https://github.com/team/project.git"
                      onChange={(event) => setRemoteUrl(event.target.value)}
                    />
                  </label>
                  <div className="git-network-actions">
                    <button
                      disabled={busy || !remoteName.trim() || !remoteUrl.trim()}
                      onClick={() =>
                        void act({ action: 'remoteSet', name: remoteName.trim(), url: remoteUrl.trim() })
                      }
                    >
                      <Save size={14} />
                      {t('git.saveRemote')}
                    </button>
                    <button
                      disabled={busy || !remote}
                      onClick={() => void act({ action: 'remoteRemove', name: remote, confirm: true })}
                    >
                      {t('git.removeRemote')}
                    </button>
                  </div>
                  {state.remotes.map((item) => (
                    <p className="git-remote-summary" key={item.name}>
                      <strong>{item.name}</strong>
                      <code>{item.fetchUrl}</code>
                      {item.pushUrl !== item.fetchUrl && <code>push: {item.pushUrl}</code>}
                    </p>
                  ))}
                </div>
              )}
              {tab === 'identity' && (
                <div className="git-form">
                  <p className="subtle-note">{t('git.identityNote')}</p>
                  <label>
                    {t('git.userName')}
                    <input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label>
                    {t('git.userEmail')}
                    <input value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !name.trim() || !email.trim()}
                    onClick={() => void act({ action: 'configure', name: name.trim(), email: email.trim() })}
                  >
                    <Save size={14} />
                    {t('action.save')}
                  </button>
                </div>
              )}
              {output && (
                <details className="git-output">
                  <summary>{t('git.output')}</summary>
                  <pre>{output}</pre>
                </details>
              )}
            </div>
          </>
        ) : (
          <div className="git-empty">{t(busy ? 'console.running' : 'git.loading')}</div>
        )}
        {busy && (
          <footer className="git-progress" role="status">
            {t('git.running')}
          </footer>
        )}
      </section>
    </div>
  );
}
