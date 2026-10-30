import { ModernSelect } from './ModernSelect';
import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Settings2, Trash2, X } from 'lucide-react';
import type { BuildTarget, ProjectConfig } from '../../shared/contracts';
import type { BuildSettings, CompilerChoice } from '../../shared/build-settings';
import type { InstalledBuildTool } from '../../shared/tool-versions';
import type { Studio } from '../workspace/useStudio';
import { readProjectSettings, writeProjectSettings } from '../workspace/projectSettings';
import { flushCollaboration } from '../workspace/collaborationFlush';
import './build-settings.css';

type Scope = string;
type Language = 'common' | 'c' | 'cpp';

export default function BuildSettingsDialog({ studio, onClose }: { studio: Studio; onClose: () => void }) {
  const { t, busy } = studio;
  const current = useRef(studio);
  current.current = studio;
  const [session] = useState(() => {
    const content = studio.drafts.be ?? studio.state?.files.find((file) => file.path === 'be')?.content ?? '';
    try {
      const draft = readProjectSettings(content, studio.config!, studio.state!.build);
      if (studio.drafts.be === undefined && studio.configDirty) draft.config = studio.config!;
      return {
        root: studio.state!.projectRoot,
        content,
        configRevision: JSON.stringify(studio.config),
        draft,
      };
    } catch {
      return null;
    }
  });
  const [baseSettings, setBaseSettings] = useState<BuildSettings>(() =>
    structuredClone(session?.draft.build.settings ?? {}),
  );
  const [targets, setTargets] = useState<BuildTarget[]>(() =>
    structuredClone(session?.draft.build.targets ?? []),
  );
  const [selectedTarget, setSelectedTarget] = useState('');
  const [defaultTarget, setDefaultTarget] = useState(session?.draft.build.defaultTarget ?? '');
  const target = targets.find((target) => target.id === selectedTarget);
  const settings = target ? (target.build?.settings ?? {}) : baseSettings;
  const setSettings = (update: BuildSettings | ((value: BuildSettings) => BuildSettings)) => {
    const next = typeof update === 'function' ? update(settings) : update;
    if (target)
      setTargets((values) =>
        values.map((value) =>
          value.id === target.id ? { ...value, build: { ...value.build, settings: next } } : value,
        ),
      );
    else setBaseSettings(next);
  };
  const updateTarget = (patch: Partial<BuildTarget>) =>
    setTargets((values) =>
      values.map((value) => (value.id === selectedTarget ? { ...value, ...patch } : value)),
    );
  const addTarget = () => {
    const id = `target-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    setTargets((values) => [
      ...values,
      { id, name: `${t('buildTargets.target')} ${values.length + 1}`, root: '.' },
    ]);
    setSelectedTarget(id);
  };
  const [scope, setScope] = useState<Scope>('common');
  const [baseForceCompiler, setBaseForceCompiler] = useState(
    session?.draft.config.runtime?.forceCompiler ?? false,
  );
  const [baseCompilerRuntime, setBaseCompilerRuntime] = useState(
    session?.draft.config.runtime?.compilerRuntime ?? '',
  );
  let childConfig: Partial<ProjectConfig> | undefined;
  if (target && target.root !== '.') {
    const marker = `${target.root}/be`;
    const text = studio.drafts[marker] ?? studio.state?.files.find((file) => file.path === marker)?.content;
    try {
      if (text) childConfig = JSON.parse(text) as ProjectConfig;
    } catch {}
  }
  const forceCompiler = target
    ? (target.config?.runtime?.forceCompiler ?? childConfig?.runtime?.forceCompiler ?? baseForceCompiler)
    : baseForceCompiler;
  const compilerRuntime = target
    ? (target.config?.runtime?.compilerRuntime ??
      childConfig?.runtime?.compilerRuntime ??
      baseCompilerRuntime)
    : baseCompilerRuntime;
  const setForceCompiler = (value: boolean) =>
    target
      ? updateTarget({
          config: { ...target.config, runtime: { ...target.config?.runtime, forceCompiler: value } },
        })
      : setBaseForceCompiler(value);
  const setCompilerRuntime = (value: string) =>
    target
      ? updateTarget({
          config: {
            ...target.config,
            runtime: { ...target.config?.runtime, compilerRuntime: value || undefined },
          },
        })
      : setBaseCompilerRuntime(value);
  const forceBackends = (studio.state?.boards ?? []).filter((board) =>
    ['Esp32_S3_CAM', 'STM32F103C8T6'].includes(board.id),
  );
  const projectRuntime = studio.state?.boards.find(
    (board) =>
      board.id === (target?.config?.boardId ?? childConfig?.boardId ?? session?.draft.config.boardId),
  )?.runtimePlugin;
  const compilerPlugins = (studio.state?.boards ?? []).flatMap((board) =>
    (board.runtimePlugin?.compiler.mode === 'plugin' && board.runtimePlugin.compiler.defaultTool) ||
    (board.runtimePlugin?.compiler.mode === 'runtime' && board.runtimePlugin.compiler.managedTools?.length)
      ? [board.runtimePlugin]
      : [],
  );
  const scopes = [
    'common',
    ...(studio.state?.boards ?? []).filter((board) => board.id !== 'auto').map((board) => board.id),
  ];
  const [tools, setTools] = useState<InstalledBuildTool[]>([]);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    setPending(true);
    try {
      const next = await window.blode.toolVersionsState();
      setTools(next.installedTools ?? []);
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? t(error.message) : String(error));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);
  const choiceFor = (language: Language) =>
    scope === 'common' ? settings.common : settings.platforms?.[scope]?.[language];
  const updateChoice = (language: Language, choice: CompilerChoice) => {
    setSettings((value) =>
      scope === 'common'
        ? { ...value, common: choice }
        : {
            ...value,
            platforms: { ...value.platforms, [scope]: { ...value.platforms?.[scope], [language]: choice } },
          },
    );
  };
  const save = () =>
    void studio.perform('action.save', async () => {
      if (!session) throw new Error('error.invalidProjectDescriptor');
      const snapshot = current.current;
      const content =
        snapshot.drafts.be ?? snapshot.state?.files.find((file) => file.path === 'be')?.content ?? '';
      if (
        snapshot.state?.projectRoot !== session.root ||
        content !== session.content ||
        JSON.stringify(snapshot.config) !== session.configRevision
      )
        throw new Error('project.settingsChanged');
      const flushed = await flushCollaboration();
      if (flushed.be !== undefined && flushed.be !== session.content)
        throw new Error('project.settingsChanged');
      const config = {
        ...session.draft.config,
        runtime: {
          ...session.draft.config.runtime,
          forceCompiler: baseForceCompiler,
          compilerRuntime: baseCompilerRuntime || undefined,
        },
      };
      if (targets.some((value) => !value.name.trim() || !value.root.trim()))
        throw new Error('error.invalidBuildTarget');
      const draft = {
        ...session.draft,
        config,
        build: {
          ...session.draft.build,
          settings: baseSettings,
          targets: targets.length ? targets : undefined,
          defaultTarget: defaultTarget || undefined,
        },
      };
      await window.blode.saveFile('be', writeProjectSettings(draft), session.root);
      studio.setDrafts((values) => {
        if (values.be !== session.content) return values;
        const next = { ...values };
        delete next.be;
        return next;
      });
      await studio.refresh();
      studio.notify(t('toast.saved'));
      onClose();
    });
  const renderChoice = (language: Language) => {
    const choice = choiceFor(language) ?? { family: 'inherit' as const };
    const base =
      studio.state?.boards.find((board) => board.id === scope)?.runtimePlugin?.compiler.baseRuntime ?? scope;
    const available = tools.filter(
      (tool) => scope === 'common' || tool.platforms.includes(base as (typeof tool.platforms)[number]),
    );
    const matching = available.find(
      (tool) =>
        tool.family === choice.family &&
        (tool.family === 'arduino' || tool.directory === choice.directory) &&
        tool.arduinoCli === choice.arduinoCli &&
        tool.packageDirectory === choice.packageDirectory &&
        tool.version === choice.version,
    );
    const selected =
      choice.family === 'plugin'
        ? `plugin:${choice.pluginId}`
        : ['inherit', 'auto'].includes(choice.family)
          ? choice.family
          : (matching?.id ?? 'custom');
    const families =
      base === 'Esp32_S3_CAM'
        ? ['arduino']
        : base === 'STM32F103C8T6'
          ? ['gnu-arm', 'armclang']
          : ['gnu-arm', 'armclang', 'arduino'];
    return (
      <section className="build-compiler-row" key={language}>
        <label>
          {t(`buildSettings.${language}`)}
          <ModernSelect
            value={selected}
            onChange={(event) => {
              const id = event.target.value;
              if (id === 'inherit' || id === 'auto') updateChoice(language, { family: id });
              else if (id.startsWith('plugin:'))
                updateChoice(language, { family: 'plugin', pluginId: id.slice(7) });
              else if (id === 'custom')
                updateChoice(language, { family: families[0] as CompilerChoice['family'] });
              else {
                const tool = available.find((item) => item.id === id)!;
                const { family, directory, version, arduinoCli, packageDirectory } = tool;
                updateChoice(language, {
                  family,
                  ...(family === 'arduino' ? { arduinoCli, packageDirectory } : { directory }),
                  version,
                });
              }
            }}
          >
            <option value="inherit">
              {t(
                scope === 'common'
                  ? 'buildSettings.followProject'
                  : language === 'common'
                    ? 'buildSettings.followCommon'
                    : 'buildSettings.followPlatform',
              )}
            </option>
            <option value="auto">{t('buildSettings.auto')}</option>
            <optgroup label={t('buildSettings.installed')}>
              {available.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.name.includes(tool.version) ? tool.name : `${tool.name} · ${tool.version}`}
                </option>
              ))}
            </optgroup>
            {!!compilerPlugins.length && (
              <optgroup label={t('buildSettings.pluginCompilers')}>
                {compilerPlugins.map((plugin) => (
                  <option key={plugin.id} value={`plugin:${plugin.id}`}>
                    {plugin.name} ·{' '}
                    {plugin.compiler.defaultTool?.id ??
                      plugin.compiler.managedTools?.map((tool) => tool.name).join(' / ')}
                    {plugin.compiler.defaultTool?.version ? ` ${plugin.compiler.defaultTool.version}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {choice.family === 'plugin' &&
              !compilerPlugins.some((plugin) => plugin.id === choice.pluginId) && (
                <option value={selected}>
                  {choice.pluginId} · {t('buildSettings.pluginUnavailable')}
                </option>
              )}
            <option value="custom">{t('buildSettings.custom')}</option>
          </ModernSelect>
        </label>
        {choice.family === 'plugin' && (
          <p className="build-tool-path">
            {
              compilerPlugins.find((plugin) => plugin.id === choice.pluginId)?.compiler.defaultTool
                ?.executable
            }
          </p>
        )}
        {matching && (
          <p className="build-tool-path">
            {matching.directory ?? matching.arduinoCli}
            {matching.packageDirectory && (
              <>
                <br />
                {matching.packageDirectory}
              </>
            )}
          </p>
        )}
        {selected === 'custom' && (
          <div className="build-custom-tool">
            <label>
              {t('buildSettings.family')}
              <ModernSelect
                value={choice.family}
                onChange={(event) =>
                  updateChoice(language, { family: event.target.value as CompilerChoice['family'] })
                }
              >
                {!families.includes(choice.family) && <option value={choice.family}>{choice.family}</option>}
                {families.map((family) => (
                  <option key={family} value={family}>
                    {family === 'gnu-arm'
                      ? 'GNU Arm GCC'
                      : family === 'armclang'
                        ? 'Arm Compiler 6'
                        : 'Arduino / ESP32'}
                  </option>
                ))}
              </ModernSelect>
            </label>
            <label>
              {t('buildSettings.version')}
              <input
                value={choice.version ?? ''}
                placeholder={t('buildSettings.versionOptional')}
                onChange={(event) =>
                  updateChoice(language, { ...choice, version: event.target.value.trim() || undefined })
                }
              />
            </label>
            {choice.family === 'arduino' ? (
              <>
                <label className="build-settings-wide">
                  Arduino CLI
                  <input
                    value={choice.arduinoCli ?? ''}
                    onChange={(event) =>
                      updateChoice(language, { ...choice, arduinoCli: event.target.value || undefined })
                    }
                  />
                </label>
                <label className="build-settings-wide">
                  {t('buildSettings.packageDirectory')}
                  <input
                    value={choice.packageDirectory ?? ''}
                    onChange={(event) =>
                      updateChoice(language, { ...choice, packageDirectory: event.target.value || undefined })
                    }
                  />
                </label>
              </>
            ) : (
              <label className="build-settings-wide">
                {t('buildSettings.directory')}
                <input
                  value={choice.directory ?? ''}
                  onChange={(event) =>
                    updateChoice(language, { ...choice, directory: event.target.value || undefined })
                  }
                />
              </label>
            )}
          </div>
        )}
      </section>
    );
  };
  return (
    <div className="modal-backdrop workspace-dialog-backdrop">
      <section
        className="modal build-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="build-settings-title"
      >
        <div className="modal-title">
          <h3 id="build-settings-title">
            <Settings2 size={18} />
            {t('buildSettings.title')}
          </h3>
          <button className="icon-button" disabled={!!busy} aria-label={t('action.close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!session ? (
          <p role="alert">{t('error.invalidProjectDescriptor')}</p>
        ) : (
          <>
            <div className="build-target-selector">
              <label>
                {t('buildTargets.target')}
                <ModernSelect
                  value={selectedTarget}
                  onChange={(event) => setSelectedTarget(event.target.value)}
                >
                  <option value="">{t('buildTargets.workspaceDefaults')}</option>
                  {targets.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </ModernSelect>
              </label>
              <button disabled={!!busy || targets.length >= 64} onClick={addTarget}>
                <Plus size={14} />
                {t('buildTargets.add')}
              </button>
              {target && (
                <button
                  className="icon-button"
                  disabled={!!busy}
                  aria-label={t('buildTargets.remove')}
                  onClick={() => {
                    setTargets((values) => values.filter((value) => value.id !== target.id));
                    if (defaultTarget === target.id) setDefaultTarget('');
                    setSelectedTarget('');
                  }}
                >
                  <Trash2 size={15} />
                </button>
              )}
              {targets.length > 1 && (
                <label>
                  {t('buildTargets.default')}
                  <ModernSelect
                    value={defaultTarget}
                    onChange={(event) => setDefaultTarget(event.target.value)}
                  >
                    <option value="">{t('buildTargets.askEachTime')}</option>
                    {targets.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                      </option>
                    ))}
                  </ModernSelect>
                </label>
              )}
            </div>
            {target && (
              <fieldset className="build-target-fields" disabled={!!busy}>
                <label>
                  {t('buildTargets.name')}
                  <input
                    value={target.name}
                    maxLength={120}
                    onChange={(event) => updateTarget({ name: event.target.value })}
                  />
                </label>
                <label>
                  {t('buildTargets.directory')}
                  <input
                    value={target.root}
                    placeholder="projects/controller"
                    onChange={(event) => updateTarget({ root: event.target.value.replaceAll('\\', '/') })}
                  />
                </label>
                <label>
                  {t('device.board')}
                  <ModernSelect
                    value={target.config?.boardId ?? ''}
                    onChange={(event) => {
                      const config = { ...target.config };
                      if (event.target.value) config.boardId = event.target.value;
                      else delete config.boardId;
                      updateTarget({ config });
                    }}
                  >
                    <option value="">{t('buildTargets.followDescriptor')}</option>
                    {(studio.state?.boards ?? []).map((board) => (
                      <option key={board.id} value={board.id}>
                        {board.name}
                      </option>
                    ))}
                  </ModernSelect>
                </label>
                <label>
                  {t('buildTargets.entry')}
                  <input
                    value={target.build?.entry ?? ''}
                    placeholder={t('buildTargets.followDescriptor')}
                    onChange={(event) =>
                      updateTarget({ build: { ...target.build, entry: event.target.value || undefined } })
                    }
                  />
                </label>
                <label>
                  {t('buildTargets.cStandard')}
                  <ModernSelect
                    value={target.build?.cStandard ?? ''}
                    onChange={(event) =>
                      updateTarget({
                        build: {
                          ...target.build,
                          cStandard:
                            (event.target.value as NonNullable<BuildTarget['build']>['cStandard']) ||
                            undefined,
                        },
                      })
                    }
                  >
                    <option value="">{t('buildTargets.followDescriptor')}</option>
                    {['c99', 'c11', 'c17', 'c23'].map((standard) => (
                      <option key={standard} value={standard}>
                        {standard.toUpperCase()}
                      </option>
                    ))}
                  </ModernSelect>
                </label>
              </fieldset>
            )}
            <div className="build-settings-body">
              <aside className="build-settings-nav" aria-label={t('buildSettings.scope')}>
                {scopes.map((value) => (
                  <button
                    key={value}
                    className={scope === value ? 'active' : ''}
                    aria-pressed={scope === value}
                    onClick={() => setScope(value)}
                  >
                    {value === 'common'
                      ? t('buildSettings.common')
                      : (studio.state?.boards.find((board) => board.id === value)?.name ?? value)}
                  </button>
                ))}
              </aside>
              <div className="build-settings-detail">
                <fieldset disabled={!!busy} className="build-mode-fields">
                  <label>
                    {t('buildSettings.mode')}
                    <ModernSelect
                      value={settings.mode ?? (target ? 'inherit' : 'release')}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          mode:
                            event.target.value === 'inherit'
                              ? undefined
                              : (event.target.value as BuildSettings['mode']),
                        })
                      }
                    >
                      {target && <option value="inherit">{t('buildSettings.followProject')}</option>}
                      <option value="debug">{t('buildSettings.debug')}</option>
                      <option value="release">{t('buildSettings.release')}</option>
                    </ModernSelect>
                  </label>
                  <label className="build-size-option">
                    <input
                      type="checkbox"
                      checked={settings.mode !== 'debug' && (settings.optimizeForSize ?? true)}
                      disabled={settings.mode === 'debug'}
                      onChange={(event) =>
                        setSettings({ ...settings, optimizeForSize: event.target.checked })
                      }
                    />
                    {t('buildSettings.optimizeSize')}
                  </label>
                </fieldset>
                {(projectRuntime || compilerPlugins.length > 0 || forceCompiler) && (
                  <div className="build-plugin-compiler">
                    {projectRuntime?.compiler.defaultTool && (
                      <p>
                        <strong>{t('buildSettings.runtimeCompiler')}</strong>
                        <code>
                          {projectRuntime.compiler.defaultTool.id}
                          {projectRuntime.compiler.defaultTool.version
                            ? ` ${projectRuntime.compiler.defaultTool.version}`
                            : ''}
                        </code>
                      </p>
                    )}
                    <label className="build-size-option">
                      <input
                        type="checkbox"
                        checked={forceCompiler}
                        disabled={!!busy}
                        onChange={(event) => setForceCompiler(event.target.checked)}
                      />
                      {t('buildSettings.forceCompiler')}
                    </label>
                    {forceCompiler && (
                      <label className="build-force-backend">
                        {t('buildSettings.forceBackend')}
                        <ModernSelect
                          value={compilerRuntime}
                          disabled={!!busy}
                          onChange={(event) => setCompilerRuntime(event.target.value)}
                        >
                          <option value="">{t('buildSettings.followRuntime')}</option>
                          {forceBackends.map((board) => (
                            <option key={board.id} value={board.id}>
                              {board.name}
                            </option>
                          ))}
                          {compilerRuntime &&
                            !forceBackends.some((board) => board.id === compilerRuntime) && (
                              <option value={compilerRuntime}>{compilerRuntime}</option>
                            )}
                        </ModernSelect>
                      </label>
                    )}
                  </div>
                )}
                <div className="build-tool-heading">
                  <h4>{t('buildSettings.compiler')}</h4>
                  <button className="text-button" disabled={pending || !!busy} onClick={() => void refresh()}>
                    <RefreshCw size={13} />
                    {t('action.refresh')}
                  </button>
                </div>
                {pending && <p role="status">{t('buildSettings.detecting')}</p>}
                <fieldset disabled={!!busy || pending} className="build-compiler-fields">
                  {renderChoice('common')}
                  {scope !== 'common' && (
                    <>
                      {renderChoice('c')}
                      {renderChoice('cpp')}
                    </>
                  )}
                </fieldset>
                {notice && <p role="status">{notice}</p>}
              </div>
            </div>
          </>
        )}
        <div className="modal-actions">
          <button disabled={!!busy} onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button className="primary" disabled={!!busy || !session} onClick={save}>
            {t('action.save')}
          </button>
        </div>
      </section>
    </div>
  );
}
