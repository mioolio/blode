import { CircleCheck, CircleX, Download, Save } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ProjectConfig, ToolchainStatus } from '../../shared/contracts';
import { useI18n, type Locale } from '../i18n';

interface Props {
  config: ProjectConfig;
  status: ToolchainStatus;
  onChange: (value: ProjectConfig) => void;
  onSave: () => void;
  onInstall: () => void;
  busy: boolean;
}

const tools = [
  { id: 'arduinoCli', name: 'Arduino CLI', versionKey: 'arduinoCli' },
  { id: 'esp32Core', name: 'Arduino-ESP32', versionKey: 'esp32' },
  { id: 'python', name: 'Python', versionKey: 'python' },
  { id: 'esptool', name: 'esptool', versionKey: 'esptool' },
] as const;

export function Settings({ config, status, onChange, onSave, onInstall, busy }: Props) {
  const { t, locale, setLocale } = useI18n();
  const [urlsText, setUrlsText] = useState(config.toolchain.additionalUrls.join('\n'));
  const urlsCanonical = config.toolchain.additionalUrls.join('\n');
  useEffect(() => {
    // Preserve a trailing newline while typing a second URL, but follow external config changes.
    if (
      urlsText
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
        .join('\n') !== urlsCanonical
    )
      setUrlsText(urlsCanonical);
  }, [urlsCanonical]);
  const tool = (values: Partial<ProjectConfig['toolchain']>) =>
    onChange({ ...config, toolchain: { ...config.toolchain, ...values } });

  return (
    <div className="settings-view view-scroll">
      <fieldset disabled={busy} style={{ display: 'contents' }}>
        <div className="settings-toolbar">
          <span className="workspace-note">{t('settings.subtitle')}</span>
          <button className="primary" onClick={onSave}>
            <Save size={13} strokeWidth={1.9} aria-hidden="true" />
            {t('action.apply')}
          </button>
        </div>
        <section className="settings-card">
          <h3>{t('settings.project')}</h3>
          <div className="form-two">
            <label>
              {t('settings.name')}
              <input
                value={config.name}
                onChange={(event) => onChange({ ...config, name: event.target.value })}
              />
            </label>
            <label>
              {t('settings.language')}
              <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
                <option value="zh-CN">{t('language.zh-CN')}</option>
                <option value="en">{t('language.en')}</option>
              </select>
            </label>
          </div>
        </section>
        <section className="settings-card">
          <h3>{t('settings.toolchain')}</h3>
          <div className="segmented">
            <button
              className={config.toolchain.mode === 'managed' ? 'active' : ''}
              onClick={() => tool({ mode: 'managed' })}
            >
              {t('settings.managed')}
            </button>
            <button
              className={config.toolchain.mode === 'custom' ? 'active' : ''}
              onClick={() => tool({ mode: 'custom' })}
            >
              {t('settings.custom')}
            </button>
          </div>
          <p className="subtle-note">{t('settings.note')}</p>
          {config.toolchain.mode === 'custom' && (
            <div className="form-two">
              <label>
                {t('settings.cli')}
                <input
                  value={config.toolchain.arduinoCli}
                  placeholder="C:\\tools\\arduino-cli.exe"
                  onChange={(event) => tool({ arduinoCli: event.target.value })}
                />
              </label>
              <label>
                {t('settings.python')}
                <input
                  value={config.toolchain.python}
                  placeholder="python"
                  onChange={(event) => tool({ python: event.target.value })}
                />
              </label>
            </div>
          )}
          <label>
            {t('settings.fqbn')}
            <input value={config.toolchain.fqbn} onChange={(event) => tool({ fqbn: event.target.value })} />
          </label>
          <label>
            {t('settings.urls')}
            <textarea
              rows={3}
              value={urlsText}
              onChange={(event) => {
                setUrlsText(event.target.value);
                tool({
                  additionalUrls: event.target.value
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean),
                });
              }}
            />
          </label>
          <button className="secondary" onClick={onInstall}>
            <Download size={13} strokeWidth={1.9} aria-hidden="true" />
            {t('action.install')}
          </button>
        </section>
      </fieldset>
      <section className="settings-card">
        <h3>{t('settings.status')}</h3>
        <div className="toolchain-grid">
          {tools.map(({ id, name, versionKey }) => (
            <div className="toolchain-item" key={id}>
              {status[id] ? (
                <CircleCheck size={14} strokeWidth={1.9} className="tone-ok" aria-hidden="true" />
              ) : (
                <CircleX size={14} strokeWidth={1.9} className="tone-missing" aria-hidden="true" />
              )}
              <span>{name}</span>
              <small>
                {status.versions[versionKey] || t(status[id] ? 'settings.available' : 'settings.missing')}
              </small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
