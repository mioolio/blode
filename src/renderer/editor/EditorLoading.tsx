import { useI18n } from '../i18n';

/** Keep the real source readable while Monaco's optional bundle initializes. */
export function EditorLoading({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <div className="editor-source-preview" aria-busy="true">
      <span role="status">{t('editor.loading')}</span>
      <pre>{value}</pre>
    </div>
  );
}
