import { useEffect, useId, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { ModelServiceConfiguration, ModelServiceState } from '../../shared/model-service';
import { useI18n } from '../i18n';
import { ModernSelect } from './ModernSelect';
import './model-provider-settings.css';

type Form = Omit<ModelServiceConfiguration, 'revision' | 'apiKey' | 'removeKey' | 'confirm'>;
const formOf = (state: ModelServiceState): Form => ({
  provider: state.provider,
  baseUrl: state.baseUrl,
  model: state.model,
  predictionModel: state.predictionModel,
  predictionSource: state.predictionSource,
});
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(error);

export function ModelProviderSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<ModelServiceState>();
  const [form, setForm] = useState<Form>();
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const modelList = useId();
  const load = async () => {
    try {
      const next = await window.blode.modelServiceState();
      setState(next);
      setForm(formOf(next));
      setApiKey('');
      setError('');
    } catch (error) {
      setError(messageOf(error));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async (removeKey = false) => {
    if (!state || !form) return;
    const next = await window.blode.modelServiceConfigure({
      ...form,
      revision: state.revision,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(removeKey ? { removeKey: true } : {}),
      confirm: true,
    });
    setState(next);
    setForm(formOf(next));
    setApiKey('');
    return next;
  };
  const perform = async (operation: 'save' | 'test' | 'remove') => {
    if (busy || !state || !form) return;
    setBusy(operation);
    setError('');
    setStatus('');
    try {
      if (operation !== 'test' || apiKey.trim() || JSON.stringify(form) !== JSON.stringify(formOf(state)))
        await save(operation === 'remove');
      if (operation === 'test') {
        const response = await window.blode.modelServiceTest();
        setModels(response.models);
        setStatus(t('model.connected'));
      } else setStatus(t('toast.configSaved'));
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="settings-card model-provider-settings">
      <div className="settings-card-head">
        <h3>{t('model.title')}</h3>
        <button
          className="text-button"
          onClick={() => void load()}
          disabled={!!busy}
          title={t('action.refresh')}
          aria-label={t('action.refresh')}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {form && state && (
        <>
          <div className="model-settings-grid">
            <label>
              {t('model.provider')}
              <ModernSelect
                value={form.provider}
                disabled={!!busy}
                onChange={(event) => {
                  const preset = state.presets.find((item) => item.id === event.target.value);
                  if (!preset) return;
                  setForm({
                    ...form,
                    provider: preset.id,
                    baseUrl: preset.baseUrl,
                    model: preset.model,
                    predictionModel: preset.model,
                  });
                  setApiKey('');
                  setModels([]);
                  setStatus('');
                }}
              >
                {state.presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </ModernSelect>
            </label>
            <label>
              {t('model.source')}
              <ModernSelect
                value={form.predictionSource}
                disabled={!!busy}
                onChange={(event) =>
                  setForm({ ...form, predictionSource: event.target.value as Form['predictionSource'] })
                }
              >
                <option value="provider">{t('model.source.provider')}</option>
                <option value="external">{t('model.source.external')}</option>
              </ModernSelect>
            </label>
            <label className="model-wide">
              {t('model.baseUrl')}
              <input
                type="url"
                spellCheck={false}
                value={form.baseUrl}
                disabled={!!busy}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </label>
            <label className="model-wide">
              {t('model.apiKey')}
              <div className="model-secret-row">
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={apiKey}
                  disabled={!!busy}
                  placeholder={
                    state.hasKey && form.provider === state.provider && form.baseUrl === state.baseUrl
                      ? t('model.keyStored')
                      : 'API Key'
                  }
                  onChange={(event) => setApiKey(event.target.value)}
                />
                {state.hasKey && form.provider === state.provider && form.baseUrl === state.baseUrl && (
                  <button
                    className="text-button"
                    disabled={!!busy}
                    aria-label={t('model.removeKey')}
                    title={t('model.removeKey')}
                    onClick={() => void perform('remove')}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </label>
            <label>
              {t('model.model')}
              <input
                value={form.model}
                list={modelList}
                spellCheck={false}
                disabled={!!busy}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
              />
            </label>
            <label>
              {t('model.predictionModel')}
              <input
                value={form.predictionModel}
                list={modelList}
                spellCheck={false}
                disabled={!!busy}
                onChange={(event) => setForm({ ...form, predictionModel: event.target.value })}
              />
            </label>
          </div>
          <datalist id={modelList}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <div className="model-settings-actions">
            <button className="primary" disabled={!!busy} onClick={() => void perform('save')}>
              {busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{' '}
              {t('model.save')}
            </button>
            <button className="secondary" disabled={!!busy} onClick={() => void perform('test')}>
              {busy === 'test' && <LoaderCircle size={14} className="spin" />}
              {t('model.test')}
            </button>
            {status && (
              <span className="model-settings-status" role="status">
                <Check size={13} />
                {status}
              </span>
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error-text">
          {t(error)}
        </p>
      )}
    </section>
  );
}
