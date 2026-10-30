import { ArrowRight, Cpu, FolderOpen, History, House, Settings2, X } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';

/** Recent entries are navigation history; removing one never deletes a project. */
export function WelcomeHome({ studio }: { studio: Studio }) {
  const {
    t,
    state,
    busy,
    openProject,
    openProjectMarker,
    openRecentProject,
    removeRecentProject,
    returnToProject,
    requestCloseProject,
  } = studio;
  const recent = state?.recentProjects ?? (state?.recentProject ? [state.recentProject] : []);
  return (
    <div className="welcome-home">
      <div className="welcome-home-heading">
        <House size={27} strokeWidth={1.4} />
        <div>
          <h1>Blode Studio</h1>
          <p>{t('welcome.startSubtitle')}</p>
        </div>
      </div>
      {state?.workspaceOpen && (
        <div className="welcome-current">
          <div>
            <strong>{state.config.name}</strong>
            <small>{state.projectRoot}</small>
          </div>
          <button className="primary" onClick={returnToProject}>
            <ArrowRight size={14} />
            {t('welcome.returnToProject')}
          </button>
          <button onClick={requestCloseProject} disabled={!!busy}>
            {t('project.close')}
          </button>
        </div>
      )}
      <div className="welcome-home-columns">
        <section className="welcome-actions">
          <h2>{t('welcome.start')}</h2>
          <button onClick={openProject} disabled={!!busy}>
            <FolderOpen size={20} />
            <span>
              <strong>{t('project.openFolder')}</strong>
              <small>{t('welcome.openFolderHint')}</small>
            </span>
          </button>
          <button onClick={openProjectMarker} disabled={!!busy}>
            <FolderOpen size={20} />
            <span>
              <strong>{t('welcome.selectFile')}</strong>
              <small>{t('welcome.openMarkerHint')}</small>
            </span>
          </button>
          <button
            onClick={() =>
              window.dispatchEvent(new CustomEvent('blode:firmware-tools', { detail: { mode: 'flash' } }))
            }
            disabled={!!busy}
          >
            <Cpu size={20} />
            <span>
              <strong>{t('firmware.flashStandalone')}</strong>
              <small>{t('welcome.standaloneHint')}</small>
            </span>
          </button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('blode:preferences'))}>
            <Settings2 size={20} />
            <span>
              <strong>{t('menu.preferences')}</strong>
              <small>{t('welcome.preferencesHint')}</small>
            </span>
          </button>
        </section>
        <section className="welcome-recents">
          <h2>
            <History size={16} />
            {t('welcome.recentProjects')}
          </h2>
          {recent.length ? (
            recent.map((project) => (
              <div className="welcome-recent-row" key={project.path}>
                <button
                  className="welcome-recent-open"
                  onClick={() => void openRecentProject(project.path)}
                  disabled={!!busy}
                  title={project.path}
                >
                  <FolderOpen size={19} />
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.path}</small>
                    {!project.available && (
                      <small className="tone-missing">{t('welcome.recentUnavailable')}</small>
                    )}
                  </span>
                </button>
                <button
                  className="welcome-recent-remove"
                  aria-label={`${t('welcome.removeRecent')} ${project.name}`}
                  title={t('welcome.removeRecentHint')}
                  onClick={() => void removeRecentProject(project.path)}
                  disabled={!!busy}
                >
                  <X size={14} />
                </button>
              </div>
            ))
          ) : (
            <p className="welcome-no-recent">{t('welcome.noRecentProjects')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
