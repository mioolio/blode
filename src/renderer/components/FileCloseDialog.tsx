import { Save, TriangleAlert } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import './file-close-dialog.css';

export function FileCloseDialog({ studio }: { studio: Studio }) {
  const { t, closeFilePrompt: prompt, chooseFileClose, syncDrafts } = studio;
  if (!prompt) return null;
  return (
    <div className="modal-backdrop file-close-backdrop">
      <section
        className="modal file-close-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-file-title"
        aria-describedby="close-file-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !prompt.busy) {
            event.preventDefault();
            event.stopPropagation();
            void chooseFileClose('cancel');
          }
        }}
      >
        <div className="modal-heading">
          <span className="modal-icon warning">
            <TriangleAlert size={18} />
          </span>
          <h2 id="close-file-title">{t('dialog.closeFileTitle')}</h2>
        </div>
        <p id="close-file-description">{t('dialog.closeFileBody')}</p>
        <p className="file-close-path" title={prompt.path}>
          {prompt.path}
        </p>
        {syncDrafts && <p className="subtle-note">{t('dialog.closeFileSharedNote')}</p>}
        {prompt.error && (
          <p className="file-close-error" role="alert">
            {t(prompt.error)}
          </p>
        )}
        <div className="modal-actions file-close-actions">
          <button disabled={prompt.busy} onClick={() => void chooseFileClose('cancel')}>
            {t('action.cancel')}
          </button>
          <button disabled={prompt.busy} onClick={() => void chooseFileClose('discard')}>
            {t('dialog.closeFileDiscard')}
          </button>
          <button
            className="primary"
            autoFocus
            disabled={prompt.busy}
            onClick={() => void chooseFileClose('save')}
          >
            <Save size={14} />
            {t(prompt.busy ? 'dialog.closeFileSaving' : 'dialog.closeFileSave')}
          </button>
        </div>
      </section>
    </div>
  );
}
