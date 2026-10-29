import { useEffect, useState } from 'react';
import type { AiAssistanceConfiguration, AiAssistanceState } from '../../shared/ai';
import { useI18n } from '../i18n';
import { setCompletionCatalog } from '../editor/completionProvider';
import './ai-completion-settings.css';

/** The same declarative catalog is editable here and through the authenticated AI API. */
export function AiCompletionSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<AiAssistanceState | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const apply = (next: AiAssistanceState, replaceText = true) => {
    setState(next);
    setCompletionCatalog(next);
    if (replaceText)
      setText(JSON.stringify({ useBuiltins: next.useBuiltins, entries: next.entries }, null, 2));
    setChangedElsewhere(false);
  };
  const load = async () => {
    try {
      apply(await window.blode.aiAssistanceState());
      setError('');
    } catch (failure) {
      setError(String(failure));
    }
  };
  useEffect(() => {
    void load();
    return window.blode.onEvent((event) => {
      // Preserve the user's unsaved JSON if an AI changes preferences concurrently.
      if (event.message === 'status.aiAssistanceChanged') setChangedElsewhere(true);
    });
  }, []);
  const save = async (patch: Omit<AiAssistanceConfiguration, 'revision'>, replaceText = true) => {
    if (!state || busy) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      apply(await window.blode.aiAssistanceConfigure({ revision: state.revision, ...patch }), replaceText);
      setSaved(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card ai-completion-settings">
      <div className="settings-card-head">
        <h3>{t('ai.completions.title')}</h3>
        <button className="text-button" onClick={() => void load()} disabled={busy}>
          {t('action.refresh')}
        </button>
      </div>
      <p className="subtle-note">{t('ai.completions.note')}</p>
      <label className="ai-prediction-toggle">
        <input
          type="checkbox"
          checked={state?.predictionEnabled ?? false}
          disabled={!state || busy}
          onChange={(event) => void save({ predictionEnabled: event.target.checked }, false)}
        />
        <span>{t('ai.completions.predictions')}</span>
      </label>
      <p className="subtle-note">{t('ai.completions.predictionNote')}</p>
      <label>
        {t('ai.completions.catalog')}
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSaved(false);
          }}
          rows={11}
          spellCheck={false}
          disabled={!state || busy}
        />
      </label>
      <p className="subtle-note">{t('ai.completions.catalogNote')}</p>
      <div className="ai-completion-actions">
        <button
          className="primary"
          disabled={!state || busy}
          onClick={() => {
            try {
              const parsed: unknown = JSON.parse(text);
              if (
                !parsed ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed) ||
                Object.keys(parsed).some((key) => !['useBuiltins', 'entries'].includes(key))
              )
                throw new Error('error.aiCatalogInvalid');
              const catalog = parsed as Pick<AiAssistanceConfiguration, 'useBuiltins' | 'entries'>;
              if (typeof catalog.useBuiltins !== 'boolean' || !Array.isArray(catalog.entries))
                throw new Error('error.aiCatalogInvalid');
              void save(catalog);
            } catch {
              setError('error.aiCatalogInvalid');
            }
          }}
        >
          {t('ai.completions.save')}
        </button>
        <button
          className="secondary"
          disabled={!state || busy}
          onClick={() => void save({ resetCatalog: true })}
        >
          {t('ai.completions.reset')}
        </button>
        {saved && <span role="status">{t('ai.completions.saved')}</span>}
      </div>
      {changedElsewhere && (
        <p className="ai-completion-warning" role="status">
          {t('ai.completions.changedElsewhere')}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {t(error)}
        </p>
      )}
      <details>
        <summary>{t('ai.completions.builtins')}</summary>
        <pre>{JSON.stringify(state?.builtins ?? [], null, 2)}</pre>
      </details>
    </section>
  );
}
