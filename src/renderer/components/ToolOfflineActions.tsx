import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Save, X } from 'lucide-react';
import type { ToolPackageResult, ToolVersionEntry, ToolVersionsState } from '../../shared/tool-versions';
import { pickHostPath } from '../workspace/hostPicker';
import { useI18n } from '../i18n';
export function ToolOfflineActions({
  entry,
  state,
  disabled,
  onInstalled,
  onPendingChange,
}: {
  entry?: ToolVersionEntry;
  state?: ToolVersionsState;
  disabled: boolean;
  onInstalled: (state: ToolVersionsState) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useI18n(),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [result, setResult] = useState<ToolPackageResult>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const saved = state?.archives?.find((item) => item.toolId === entry?.id);
  const archive = result?.toolId === entry?.id ? result : saved;
  const perform = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    onPendingChange?.(true);
    setNotice('');
    try {
      await action();
    } catch (error) {
      if (mounted.current)
        setNotice(
          t(
            (error instanceof Error ? error.message : String(error)).replace(
              /^Error invoking remote method '[^']+': (?:Error: )?/,
              '',
            ),
          ),
        );
    } finally {
      onPendingChange?.(false);
      if (mounted.current) setPending(false);
    }
  };
  const save = async (item: ToolPackageResult) => {
    if (await window.blode.toolVersionPackageSave(item.id))
      if (mounted.current) setNotice(t('settings.versions.archiveReady'));
  };
  return (
    <div className="tool-offline-actions">
      <div className="tool-version-actions">
        {entry?.installable && (
          <button
            disabled={disabled || pending}
            onClick={() =>
              void perform(async () => {
                const downloaded = await window.blode.toolVersionDownload({ id: entry.id, confirm: true });
                if (!mounted.current) return;
                setResult(downloaded);
                setNotice(t('settings.versions.downloaded'));
                await save(downloaded);
              })
            }
          >
            <Download size={13} />
            {t('settings.versions.downloadOnly')}
          </button>
        )}
        <button
          disabled={disabled || pending}
          onClick={() =>
            void perform(async () => {
              const file = await pickHostPath({ kind: 'file', extensions: ['zip'] });
              if (!file || !mounted.current) return;
              const installed = await window.blode.toolVersionImport({ path: file, confirm: true });
              if (!mounted.current) return;
              onInstalled(installed);
              setNotice(t('settings.versions.installed'));
            })
          }
        >
          <FolderOpen size={13} />
          {t('settings.versions.importOffline')}
        </button>
        {pending && (
          <button onClick={() => void window.blode.toolVersionCancel().catch(() => {})}>
            <X size={13} />
            {t('action.cancel')}
          </button>
        )}
        {archive && (
          <button disabled={disabled || pending} onClick={() => void perform(() => save(archive))}>
            <Save size={13} />
            {t('settings.versions.saveArchive')}
          </button>
        )}
      </div>
      {archive && (
        <p className="tool-version-notice" title={`SHA-256 ${archive.sha256}`}>
          {archive.name} · {t('settings.versions.downloaded')}
        </p>
      )}
      {notice && (
        <p className="tool-version-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
