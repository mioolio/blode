import { useEffect, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import {
  readProjectSettings,
  writeProjectSettings,
  type ProjectSettingsDraft,
} from '../workspace/projectSettings';
import { flushCollaboration } from '../workspace/collaborationFlush';
import './project-settings.css';

export function ProjectSettingsDialog({ studio }: { studio: Studio }) {
  const { t, state, drafts, busy } = studio;
  const [draft, setDraft] = useState<ProjectSettingsDraft | null>(null);
  const base = useRef({ root: '', content: '' });
  const current = useRef(studio);
  current.current = studio;
  useEffect(() => {
    const open = () => {
      const next = current.current;
      if (!next.state?.workspaceOpen || !next.config) return;
      try {
        const content = next.drafts.be ?? next.state.files.find((file) => file.path === 'be')?.content ?? '';
        base.current = { root: next.state.projectRoot, content };
        const settings = readProjectSettings(content, next.config, next.state.build);
        if (next.drafts.be === undefined && next.configDirty) settings.config = next.config;
        setDraft(settings);
      } catch {
        next.notify(next.t('error.invalidProjectDescriptor'), true);
      }
    };
    window.addEventListener('blode:project-settings', open);
    return () => window.removeEventListener('blode:project-settings', open);
  }, []);
  useEffect(() => {
    setDraft(null);
  }, [state?.projectRoot]);
  useEffect(() => {
    if (!draft) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setDraft(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [!!draft, busy]);
  if (!draft || !state) return null;
  const update = (value: Partial<ProjectSettingsDraft>) => setDraft({ ...draft, ...value });
  const updateConfig = (value: Partial<ProjectSettingsDraft['config']>) =>
    update({ config: { ...draft.config, ...value } });
  const save = () =>
    void studio.perform('action.save', async () => {
      const snapshot = current.current;
      const content =
        snapshot.drafts.be ?? snapshot.state?.files.find((file) => file.path === 'be')?.content ?? '';
      if (snapshot.state?.projectRoot !== base.current.root || content !== base.current.content)
        throw new Error('project.settingsChanged');
      const flushed = await flushCollaboration();
      if (flushed.be !== undefined && flushed.be !== base.current.content)
        throw new Error('project.settingsChanged');
      await window.blode.saveFile('be', writeProjectSettings(draft));
      studio.setDrafts((values) => {
        if (values.be !== base.current.content) return values;
        const next = { ...values };
        delete next.be;
        return next;
      });
      await studio.refresh();
      setDraft(null);
      studio.notify(t('toast.saved'));
    });
  return (
    <div className="modal-backdrop workspace-dialog-backdrop">
      <section
        className="modal project-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
      >
        <div className="modal-title">
          <h3 id="project-settings-title">
            <Settings2 size={18} />
            {t('project.settings')}
          </h3>
          <button
            className="icon-button"
            disabled={!!busy}
            aria-label={t('action.close')}
            onClick={() => setDraft(null)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="project-settings-body">
          <fieldset className="project-settings-fields" disabled={!!busy}>
            <label>
              {t('project.settingsName')}
              <input
                autoFocus
                value={draft.config.name}
                onChange={(e) => updateConfig({ name: e.target.value })}
              />
            </label>
            <label>
              {t('device.board')}
              <select
                value={draft.config.boardId}
                onChange={(e) => {
                  const board = state.boards.find((item) => item.id === e.target.value);
                  if (board)
                    updateConfig({
                      ...board.defaultConfig,
                      name: draft.config.name,
                      toolchain: { ...draft.config.toolchain, ...board.defaultConfig.toolchain },
                    });
                }}
              >
                {state.boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('project.buildEntry')}
              <input
                value={draft.entry}
                placeholder="src/main.c"
                onChange={(e) => update({ entry: e.target.value })}
              />
            </label>
            <label>
              {t('project.cStandard')}
              <select
                value={draft.cStandard}
                onChange={(e) => update({ cStandard: e.target.value as ProjectSettingsDraft['cStandard'] })}
              >
                {['c99', 'c11', 'c17', 'c23'].map((value) => (
                  <option key={value} value={value}>
                    {value.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="project-settings-wide">
              {t('project.settingsFiles')}
              <textarea
                rows={7}
                value={draft.files}
                placeholder={'src/main.c\nstartup/startup_stm32f10x_md.s'}
                onChange={(e) => update({ files: e.target.value })}
              />
            </label>
            <label className="project-settings-wide">
              {t('settings.armCompilerDirectory')}
              <input
                value={draft.config.toolchain.armCompilerDirectory ?? ''}
                onChange={(e) =>
                  updateConfig({
                    toolchain: { ...draft.config.toolchain, armCompilerDirectory: e.target.value },
                  })
                }
              />
            </label>
          </fieldset>
          <aside className="project-settings-preview">
            <strong>be</strong>
            <pre>{writeProjectSettings(draft)}</pre>
          </aside>
        </div>
        <div className="modal-actions">
          <button disabled={!!busy} onClick={() => setDraft(null)}>
            {t('action.cancel')}
          </button>
          <button className="primary" disabled={!!busy || !draft.config.name.trim()} onClick={save}>
            {t('action.save')}
          </button>
        </div>
      </section>
    </div>
  );
}
