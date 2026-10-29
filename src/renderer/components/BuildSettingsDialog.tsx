import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Settings2, X } from 'lucide-react';
import type { BuildSettings, CompilerChoice } from '../../shared/build-settings';
import type { InstalledBuildTool } from '../../shared/tool-versions';
import type { Studio } from '../workspace/useStudio';
import { readProjectSettings, writeProjectSettings } from '../workspace/projectSettings';
import { flushCollaboration } from '../workspace/collaborationFlush';
import './build-settings.css';

type Scope = 'common' | 'stm32' | 'esp32-s3';
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
  const [settings, setSettings] = useState<BuildSettings>(() =>
    structuredClone(session?.draft.build.settings ?? {}),
  );
  const [scope, setScope] = useState<Scope>('common');
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
      const draft = { ...session.draft, build: { ...session.draft.build, settings } };
      await window.blode.saveFile('be', writeProjectSettings(draft));
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
    const available = tools.filter((tool) => scope === 'common' || tool.platforms.includes(scope));
    const matching = available.find(
      (tool) =>
        tool.family === choice.family &&
        (tool.family === 'arduino' || tool.directory === choice.directory) &&
        tool.arduinoCli === choice.arduinoCli &&
        tool.packageDirectory === choice.packageDirectory &&
        tool.version === choice.version,
    );
    const selected = ['inherit', 'auto'].includes(choice.family) ? choice.family : (matching?.id ?? 'custom');
    const families =
      scope === 'esp32-s3'
        ? ['arduino']
        : scope === 'stm32'
          ? ['gnu-arm', 'armclang']
          : ['gnu-arm', 'armclang', 'arduino'];
    return (
      <section className="build-compiler-row" key={language}>
        <label>
          {t(`buildSettings.${language}`)}
          <select
            value={selected}
            onChange={(event) => {
              const id = event.target.value;
              if (id === 'inherit' || id === 'auto') updateChoice(language, { family: id });
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
            <option value="custom">{t('buildSettings.custom')}</option>
          </select>
        </label>
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
              <select
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
              </select>
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
          <div className="build-settings-body">
            <aside className="build-settings-nav" aria-label={t('buildSettings.scope')}>
              {(['common', 'stm32', 'esp32-s3'] as const).map((value) => (
                <button
                  key={value}
                  className={scope === value ? 'active' : ''}
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                >
                  {value === 'common' ? t('buildSettings.common') : value === 'stm32' ? 'STM32' : 'ESP32-S3'}
                </button>
              ))}
            </aside>
            <div className="build-settings-detail">
              <fieldset disabled={!!busy} className="build-mode-fields">
                <label>
                  {t('buildSettings.mode')}
                  <select
                    value={settings.mode ?? 'release'}
                    onChange={(event) =>
                      setSettings({ ...settings, mode: event.target.value as BuildSettings['mode'] })
                    }
                  >
                    <option value="debug">{t('buildSettings.debug')}</option>
                    <option value="release">{t('buildSettings.release')}</option>
                  </select>
                </label>
                <label className="build-size-option">
                  <input
                    type="checkbox"
                    checked={settings.mode !== 'debug' && (settings.optimizeForSize ?? true)}
                    disabled={settings.mode === 'debug'}
                    onChange={(event) => setSettings({ ...settings, optimizeForSize: event.target.checked })}
                  />
                  {t('buildSettings.optimizeSize')}
                </label>
              </fieldset>
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
              <p className="subtle-note">{t('buildSettings.installHint')}</p>
            </div>
          </div>
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
