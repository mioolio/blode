import type { CoreService } from './service';
import type { CollaborationService } from './collaboration';

/** Identical source protection for Electron and the browser-only Node host. */
export function protectSharedWorkspace(core: CoreService, collaboration: CollaborationService) {
  const save = core.saveFile.bind(core); // Caller must give this raw callback to CollaborationService first.
  core.saveFile = (file, content) => collaboration.writeFile(core.currentProjectRoot(), file, content);
  const build = core.build.bind(core);
  core.build = async () => {
    await collaboration.flush();
    return build();
  };
  const flash = core.flash.bind(core);
  core.flash = async () => {
    if ((await collaboration.state()).documents.some((doc) => doc.dirty))
      throw new Error('error.sourceChanged');
    return flash();
  };
  const open = core.setProjectRoot.bind(core);
  core.setProjectRoot = (root) => collaboration.workspaceAction(() => open(root));
  const close = core.closeProject.bind(core);
  core.closeProject = () => collaboration.workspaceAction(close);
  const rename = core.renameEntry.bind(core);
  core.renameEntry = (from, to) => collaboration.workspaceAction(() => rename(from, to));
  const remove = core.deleteEntry.bind(core);
  core.deleteEntry = (file) => collaboration.workspaceAction(() => remove(file));
  return { save, reload: () => open(core.currentProjectRoot()) };
}
