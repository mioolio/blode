import { Copy, Cpu, FilePen, Flame, Hammer, Info, Server, Usb, Waypoints } from 'lucide-react';
import { useI18n } from '../i18n';

export function AiWorkspace({
  endpoint,
  tokenFile,
  webEndpoint,
  webTokenFile,
  allowExternal,
  syncDrafts,
  onSyncChange,
  onCopy,
}: {
  endpoint: string;
  tokenFile: string;
  webEndpoint: string;
  webTokenFile: string;
  allowExternal: boolean;
  syncDrafts: boolean;
  onSyncChange: (value: boolean) => void;
  onCopy: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ai-view view-scroll">
      <section className="view-card ai-connection">
        <div className="section-heading">
          <span className="heading-label">
            <span className="status-dot" />
            <Server size={13} strokeWidth={1.8} aria-hidden="true" />
            {t('ai.local')}
          </span>
          <span className="tiny-tag">JSON-RPC 2.0</span>
        </div>
        <p className="card-note">{t('ai.protocol')}</p>
        {[
          [t('ai.endpoint'), endpoint],
          [t('ai.token'), tokenFile],
          ...(webEndpoint ? [[t('ai.browser'), webEndpoint]] : []),
          ...(allowExternal && webTokenFile ? [[t('ai.webToken'), webTokenFile]] : []),
        ].map(([label, value]) => (
          <div className="copy-field" key={label}>
            <span>{label}</span>
            <code>{value || '—'}</code>
            <button
              className="icon-button"
              title={t('action.copy')}
              aria-label={t('action.copy')}
              onClick={() => onCopy(value)}
            >
              <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        ))}
        {webEndpoint && (
          <>
            <p className="workspace-note">{t(allowExternal ? 'ai.external' : 'ai.localOnly')}</p>
            <label className="sync-toggle">
              <input
                type="checkbox"
                checked={syncDrafts}
                onChange={(event) => onSyncChange(event.target.checked)}
              />
              <span>{t('ai.syncDrafts')}</span>
            </label>
            {!syncDrafts && <p className="workspace-note">{t('ai.independent')}</p>}
          </>
        )}
      </section>

      <section className="view-card">
        <div className="section-heading">
          <span className="heading-label">
            <Waypoints size={13} strokeWidth={1.8} aria-hidden="true" />
            {t('ai.tools')}
          </span>
        </div>
        <div className="ai-tools">
          {(
            [
              ['state.get', 'ai.read', Waypoints],
              ['file.write', 'ai.write', FilePen],
              ['build.run', 'ai.build', Hammer],
              ['flash.run', 'ai.flash', Flame],
              ['ports.list', 'ai.ports', Usb],
              ['device.probe', 'ai.probe', Cpu],
              ['capabilities.get', 'ai.capabilities', Waypoints],
              ['collaboration.edit', 'ai.collaboration', FilePen],
              ['ai.configure', 'ai.completions', FilePen],
              ['ai.predictions.poll', 'ai.predictions', Waypoints],
              ['ui.command', 'ai.ui', Waypoints],
            ] as const
          ).map(([method, key, Icon]) => (
            <div className="ai-tool" key={method}>
              <span className="ai-tool-icon">
                <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <code>{method}</code>
              <span>{t(key)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="view-card code-example">
        <div className="section-heading">{t('ai.example')}</div>
        <pre>
          {JSON.stringify(
            { jsonrpc: '2.0', id: 1, auth: '<token>', method: 'state.get', params: {} },
            null,
            2,
          )}
        </pre>
      </section>

      <div className="info-callout">
        <Info size={14} strokeWidth={1.8} aria-hidden="true" />
        <p>
          {t('ai.security')}
          <br />
          {t('ai.docs')}
        </p>
      </div>
      <div className="mcp-note">
        <strong>{t('ai.mcp')}</strong>
        <p>{t('ai.mcpHint')}</p>
      </div>
    </div>
  );
}
