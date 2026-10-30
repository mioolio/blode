import { useEffect, useState } from 'react';
import { TriangleAlert, UserRound } from 'lucide-react';
import type { CollaborationPeer, CollaborationToolTab } from '../../shared/collaboration';
import type { CollaborationWorkspace } from '../workspace/useCollaboration';
import { useI18n } from '../i18n';
import './collaboration.css';
import { peersForFile, peersForTool } from '../workspace/peerViews';

export function CollaborationAvatars({
  peers,
  path,
  tool,
}: {
  peers: CollaborationPeer[];
  path?: string;
  tool?: CollaborationToolTab;
}) {
  const { t } = useI18n();
  const users = tool ? peersForTool(peers, tool) : peersForFile(peers, path ?? '');
  const visible = users.slice(0, 3);
  return (
    <span className="collaboration-avatars">
      {visible.map((peer, index) => (
        <span
          key={peer.peerId}
          className={`collaboration-avatar${peer.editing ? ' editing' : ''}`}
          style={{ color: peer.color, zIndex: visible.length - index }}
          title={`${peer.name}${peer.clientKind === 'desktop' ? ` · ${t('collaboration.desktopPeer')}` : ''} · ${t(peer.editing ? 'collaboration.editing' : peer.viewing ? 'collaboration.viewing' : 'collaboration.opened')}${peer.viewing && !tool ? ` · ${peer.startLine}–${peer.endLine}` : ''}`}
          aria-label={`${peer.name}: ${t(peer.editing ? 'collaboration.editing' : peer.viewing ? 'collaboration.viewing' : 'collaboration.opened')}`}
        >
          <UserRound size={11} aria-hidden="true" />
        </span>
      ))}
      {users.length > visible.length && (
        <span
          className="collaboration-avatar collaboration-overflow"
          title={users
            .slice(visible.length)
            .map((peer) => peer.name)
            .join(', ')}
          aria-label={`${users.length - visible.length} ${t('collaboration.moreUsers')}`}
        >
          +{users.length - visible.length}
        </span>
      )}
    </span>
  );
}

export function CollaborationStatus({ collaboration }: { collaboration: CollaborationWorkspace }) {
  const { t } = useI18n();
  const [merging, setMerging] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const conflict = collaboration.conflicts.find((entry) => entry.path === merging);
  useEffect(() => {
    if (merging && !conflict) setMerging('');
  }, [merging, conflict]);
  if (!collaboration.conflicts.length && !collaboration.connectionError) return null;
  return (
    <>
      <div className="collaboration-notices">
        {collaboration.connectionError && (
          <div className="collaboration-notice" role="status">
            <TriangleAlert size={13} />
            <span>
              {t('collaboration.connectionError')} {t(collaboration.connectionError)}
            </span>
          </div>
        )}
        {collaboration.conflicts.map((entry) => (
          <div className="collaboration-notice" role="alert" key={entry.path}>
            <TriangleAlert size={13} />
            <span>
              <strong>{entry.path}</strong> · {t('collaboration.conflictPreserved')}
            </span>
            <button
              onClick={() => {
                setText(entry.local);
                setMerging(entry.path);
                setError('');
              }}
            >
              {t('collaboration.reviewMerge')}
            </button>
          </div>
        ))}
      </div>
      {conflict && (
        <div className="modal-backdrop">
          <div
            className="modal collaboration-merge"
            role="dialog"
            aria-modal="true"
            aria-label={t('collaboration.reviewMerge')}
          >
            <h2>
              {t('collaboration.reviewMerge')} · {conflict.path}
            </h2>
            <p>{t('collaboration.mergeHelp')}</p>
            <div className="collaboration-merge-columns">
              <label>
                {t('collaboration.sharedVersion')}
                <textarea value={conflict.shared} readOnly spellCheck={false} />
              </label>
              <label>
                {t('collaboration.mergedVersion')}
                <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
              </label>
            </div>
            {error && (
              <p className="error-text" role="alert">
                {t(error)}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={working} onClick={() => setMerging('')}>
                {t('action.cancel')}
              </button>
              <button
                disabled={working}
                onClick={() => {
                  setWorking(true);
                  void collaboration
                    .acceptShared(conflict.path)
                    .then(() => setMerging(''))
                    .catch((error) => setError(error instanceof Error ? error.message : String(error)))
                    .finally(() => setWorking(false));
                }}
              >
                {t('collaboration.acceptShared')}
              </button>
              <button
                className="primary"
                disabled={working}
                onClick={() => {
                  setWorking(true);
                  void collaboration
                    .merge(conflict.path, text)
                    .then(() => setMerging(''))
                    .catch((error) => setError(error instanceof Error ? error.message : String(error)))
                    .finally(() => setWorking(false));
                }}
              >
                {t('collaboration.applyMerge')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
