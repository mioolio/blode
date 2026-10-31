import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Package, Puzzle, RefreshCw, Trash2, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { ExtensionReview, GeneralExtensionInfo } from '../../shared/general-extensions';
import { pickHostPath } from '../workspace/hostPicker';
import { ModernSelect } from '../components/ModernSelect';
import { approvePackageVerification } from '../components/PackageTrustDialog';
import {
  extensionLabel,
  openGeneralExtensionView,
  refreshGeneralExtensions,
  updateGeneralExtensions,
  useGeneralExtensions,
} from './ShellAppearance';

export default function ExtensionManager({ onClose }: { onClose(): void }) {
  const { t, locale } = useI18n(),
    { data, error: stateError } = useGeneralExtensions();
  const [selected, setSelected] = useState(''),
    [query, setQuery] = useState(''),
    [source, setSource] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [review, setReview] = useState<ExtensionReview>(),
    [approval, setApproval] = useState<GeneralExtensionInfo>(),
    [removing, setRemoving] = useState<GeneralExtensionInfo>(),
    [permanent, setPermanent] = useState(false);
  const root = useRef<HTMLElement>(null),
    busy = useRef(false);
  busy.current = pending;
  const plugins = data?.plugins ?? [],
    plugin = plugins.find((plugin) => plugin.id === selected) ?? plugins[0];
  const run = async (action: () => Promise<unknown>) => {
    if (busy.current) return;
    setPending(true);
    busy.current = true;
    setError('');
    try {
      await action();
    } catch (error) {
      setError(t(error instanceof Error ? error.message : String(error)));
    } finally {
      setPending(false);
      busy.current = false;
    }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy.current && !document.querySelector('.host-picker-backdrop')) {
        event.stopPropagation();
        if (review) setReview(undefined);
        else if (approval) setApproval(undefined);
        else if (removing) setRemoving(undefined);
        else onClose();
      }
      if (event.key === 'Tab' && root.current) {
        const scope = root.current.querySelector<HTMLElement>('.extension-confirm') ?? root.current;
        const buttons = [
          ...scope.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length);
        const first = buttons[0],
          last = buttons.at(-1);
        if (!scope.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === root.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === root.current)
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose, !!review, !!approval, !!removing]);
  const inspect = async (path: string) => {
    if (!path) return;
    const value = await window.blode.generalExtensionReview({ path });
    setPermanent(false);
    setReview(value);
  };
  const approve = async () => {
    const target =
      approval ?? (review ? { id: review.manifest.id, fingerprint: review.fingerprint } : undefined);
    if (!target) return;
    const signatureApproval = review?.verification
      ? await approvePackageVerification(review.verification, t)
      : undefined;
    if (review && !signatureApproval) return;
    if (review)
      updateGeneralExtensions(
        await window.blode.generalExtensionInstall({
          approval: signatureApproval,
          ticket: review.ticket,
          fingerprint: review.fingerprint,
          confirm: true,
        }),
      );
    const result = await window.blode.generalExtensionEnable({
      id: target.id,
      fingerprint: target.fingerprint,
      confirm: true,
      permanent,
    });
    updateGeneralExtensions(result);
    setSelected(target.id);
    setReview(undefined);
    setApproval(undefined);
    setSource('');
  };
  const consent = approval?.manifest ?? review?.manifest;
  return (
    <div
      className="extension-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="extension-manager"
        role="dialog"
        aria-modal="true"
        aria-label={t('extensions.title')}
        tabIndex={-1}
        ref={root}
      >
        <header>
          <h2>
            <Puzzle size={18} />
            {t('extensions.title')}
          </h2>
          <div>
            <button
              title={t('action.refresh')}
              disabled={pending}
              onClick={() => void refreshGeneralExtensions()}
            >
              <RefreshCw size={16} />
            </button>
            <button aria-label={t('action.close')} disabled={pending} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>
        {(error || stateError) && (
          <p className="extension-error" role="alert">
            {error || t(stateError)}
          </p>
        )}
        <div className="extension-manager-body">
          <aside>
            <input
              placeholder={t('extensions.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <nav>
              {plugins
                .filter((plugin) =>
                  `${plugin.manifest.name} ${plugin.id}`.toLowerCase().includes(query.toLowerCase()),
                )
                .map((item) => (
                  <button
                    key={item.id}
                    className={item.id === plugin?.id ? 'active' : ''}
                    onClick={() => setSelected(item.id)}
                  >
                    <Puzzle size={16} />
                    <span>
                      <strong>{item.manifest.name}</strong>
                      <small>{item.manifest.version}</small>
                    </span>
                    <i
                      className={item.enabled ? 'enabled' : ''}
                      title={t(item.enabled ? 'extensions.enabled' : 'extensions.disabled')}
                    />
                  </button>
                ))}
            </nav>
            <footer>
              <label>{t('extensions.installFrom')}</label>
              <div>
                <input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder={t('extensions.path')}
                />
                <button
                  aria-label={t('extensions.choose')}
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      const result = await pickHostPath({ kind: 'directory' });
                      if (result) setSource(result);
                    })
                  }
                >
                  <FolderOpen size={17} />
                </button>
              </div>
              <button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const result = await pickHostPath({ kind: 'file', extensions: ['zip'] });
                    if (result) {
                      setSource(result);
                      await inspect(result);
                    }
                  })
                }
              >
                {t('extensions.chooseZip')}
              </button>
              <button
                className="primary-button"
                disabled={pending || !source.trim()}
                onClick={() => void run(() => inspect(source.trim()))}
              >
                {t('extensions.inspect')}
              </button>
              {(data?.examples ?? []).map((example) => (
                <button
                  key={example.id}
                  disabled={pending || plugins.some((plugin) => plugin.id === example.id)}
                  onClick={() => void run(() => inspect(example.path))}
                >
                  <Package size={14} />
                  {t('extensions.official')} · {example.name}
                </button>
              ))}
            </footer>
          </aside>
          <article>
            {plugin ? (
              <>
                <div className="extension-details-heading">
                  <div>
                    <h3>{plugin.manifest.name}</h3>
                    <p>
                      {plugin.manifest.vendor ?? plugin.id} · {plugin.manifest.version}
                    </p>
                  </div>
                  <span>{t(plugin.enabled ? 'extensions.enabled' : 'extensions.disabled')}</span>
                </div>
                {plugin.manifest.description && <p>{plugin.manifest.description}</p>}
                <div className="extension-details-actions">
                  <button
                    className={plugin.enabled ? '' : 'primary-button'}
                    disabled={pending || plugin.restartRequired}
                    onClick={() =>
                      void run(async () => {
                        if (plugin.enabled)
                          updateGeneralExtensions(
                            await window.blode.generalExtensionDisable({ id: plugin.id }),
                          );
                        else if (plugin.trust !== 'required')
                          updateGeneralExtensions(
                            await window.blode.generalExtensionEnable({
                              id: plugin.id,
                              fingerprint: plugin.fingerprint,
                              permanent: plugin.trust === 'permanent',
                              confirm: true,
                            }),
                          );
                        else {
                          setApproval(plugin);
                          setPermanent(false);
                        }
                      })
                    }
                  >
                    {t(plugin.enabled ? 'extensions.disable' : 'extensions.enable')}
                  </button>
                  <button
                    disabled={pending}
                    onClick={() =>
                      void run(async () => {
                        const result = await window.blode.generalExtensionExport({
                          id: plugin.id,
                          confirm: true,
                        });
                        await window.blode.generalExtensionPackageSave(result.id);
                      })
                    }
                  >
                    <Download size={14} />
                    {t('extensions.export')}
                  </button>
                  <button disabled={pending} onClick={() => setRemoving(plugin)}>
                    <Trash2 size={14} />
                    {t('extensions.remove')}
                  </button>
                </div>
                {plugin.restartRequired && <p role="status">{t('error.extensionRestartRequired')}</p>}
                <section>
                  <h4>{t('extensions.permissions')}</h4>
                  <ul className="extension-permissions">
                    {plugin.manifest.permissions.map((permission) => (
                      <li key={permission}>{t(`extensions.permission.${permission}`)}</li>
                    ))}
                  </ul>
                </section>
                {!!plugin.manifest.settings?.fields.length && (
                  <section>
                    <h4>{t('extensions.settings')}</h4>
                    <div className="extension-settings-grid">
                      {plugin.manifest.settings.fields.map((field) => (
                        <label key={field.id}>
                          <span>{extensionLabel(plugin, field.label, field.label, locale)}</span>
                          {field.type === 'select' ? (
                            <ModernSelect
                              value={String(plugin.settings[field.id] ?? '')}
                              disabled={pending || !plugin.enabled}
                              onChange={(event) =>
                                void run(async () =>
                                  updateGeneralExtensions(
                                    await window.blode.generalExtensionConfigure({
                                      id: plugin.id,
                                      values: { [field.id]: event.target.value },
                                    }),
                                  ),
                                )
                              }
                            >
                              {(field.options ?? []).map((option) => (
                                <option key={option.value} value={option.value}>
                                  {extensionLabel(plugin, option.label, option.label, locale)}
                                </option>
                              ))}
                            </ModernSelect>
                          ) : field.type === 'boolean' ? (
                            <input
                              type="checkbox"
                              checked={!!plugin.settings[field.id]}
                              disabled={pending || !plugin.enabled}
                              onChange={(event) =>
                                void run(async () =>
                                  updateGeneralExtensions(
                                    await window.blode.generalExtensionConfigure({
                                      id: plugin.id,
                                      values: { [field.id]: event.target.checked },
                                    }),
                                  ),
                                )
                              }
                            />
                          ) : (
                            <input
                              type={field.type === 'number' ? 'number' : 'text'}
                              defaultValue={String(plugin.settings[field.id] ?? '')}
                              min={field.min}
                              max={field.max}
                              disabled={pending || !plugin.enabled}
                              onBlur={(event) => {
                                const value =
                                  field.type === 'number' ? Number(event.target.value) : event.target.value;
                                if (value !== plugin.settings[field.id])
                                  void run(async () =>
                                    updateGeneralExtensions(
                                      await window.blode.generalExtensionConfigure({
                                        id: plugin.id,
                                        values: { [field.id]: value },
                                      }),
                                    ),
                                  );
                              }}
                            />
                          )}
                        </label>
                      ))}
                    </div>
                  </section>
                )}
                {!!plugin.manifest.ui.views?.length && (
                  <section>
                    <h4>{t('extensions.views')}</h4>
                    <div className="extension-details-actions">
                      {plugin.manifest.ui.views.map((view) => (
                        <button
                          key={view.id}
                          disabled={pending || !plugin.enabled}
                          onClick={() => void run(() => openGeneralExtensionView(plugin, view))}
                        >
                          {extensionLabel(plugin, view.label, view.label, locale)}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <details>
                  <summary>{t('extensions.packageDetails')}</summary>
                  <code>{plugin.directory}</code>
                  <code>SHA-256 {plugin.fingerprint}</code>
                </details>
              </>
            ) : (
              <div className="extension-empty">
                <Puzzle size={30} />
                <p>{t('extensions.empty')}</p>
              </div>
            )}
          </article>
        </div>
        {(data?.errors ?? []).length > 0 && (
          <details className="extension-diagnostics">
            <summary>{t('extensions.diagnostics')}</summary>
            {data?.errors.map((error) => (
              <p key={error.directory}>
                {error.directory}: {t(error.message)}
              </p>
            ))}
          </details>
        )}
        {consent && (
          <div className="extension-confirm-backdrop">
            <section
              className="extension-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-label={t('extensions.review')}
            >
              <h3>
                {t('extensions.review')} · {consent.name}
              </h3>
              <p>
                {consent.version} · {consent.vendor ?? consent.id}
              </p>
              <h4>{t('extensions.permissions')}</h4>
              <ul>
                {consent.permissions.map((permission) => (
                  <li key={permission}>{t(`extensions.permission.${permission}`)}</li>
                ))}
              </ul>
              {consent.permissions.includes('native') && (
                <p className="extension-native-warning">{t('extensions.nativeWarning')}</p>
              )}
              {review && (
                <details>
                  <summary>
                    {t('extensions.files')} · {review.files.length}
                  </summary>
                  <pre>{review.files.join('\n')}</pre>
                </details>
              )}
              <code className="extension-fingerprint">
                SHA-256 {approval?.fingerprint ?? review?.fingerprint}
              </code>
              <label className="extension-permanent">
                <input
                  type="checkbox"
                  checked={permanent}
                  onChange={(event) => setPermanent(event.target.checked)}
                />
                {t('extensions.remember')}
              </label>
              <footer>
                <button
                  disabled={pending}
                  onClick={() => {
                    setReview(undefined);
                    setApproval(undefined);
                  }}
                >
                  {t('action.cancel')}
                </button>
                <button className="primary-button" disabled={pending} onClick={() => void run(approve)}>
                  {t(review ? 'extensions.installEnable' : 'extensions.enable')}
                </button>
              </footer>
            </section>
          </div>
        )}
        {removing && (
          <div className="extension-confirm-backdrop">
            <section className="extension-confirm" role="alertdialog">
              <h3>
                {t('extensions.remove')} · {removing.manifest.name}
              </h3>
              <footer>
                <button disabled={pending} onClick={() => setRemoving(undefined)}>
                  {t('action.cancel')}
                </button>
                <button
                  className="primary-button"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      updateGeneralExtensions(
                        await window.blode.generalExtensionRemove({ id: removing.id, confirm: true }),
                      );
                      setRemoving(undefined);
                    })
                  }
                >
                  {t('extensions.remove')}
                </button>
              </footer>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
