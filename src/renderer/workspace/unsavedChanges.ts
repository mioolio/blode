import type { AppState, ProjectConfig } from '../../shared/contracts';

export interface UnsavedSnapshot {
  state: Pick<AppState, 'projectRoot' | 'workspaceOpen' | 'config' | 'files'> | null;
  config: ProjectConfig | null;
  drafts: Record<string, string>;
}

/** Compare content, not tab ownership or a transient render's dirty counter. */
export function hasUnsavedChanges(snapshot: UnsavedSnapshot, canonical = snapshot.state): boolean {
  if (!snapshot.state?.workspaceOpen) return false;
  if (!canonical || canonical.projectRoot !== snapshot.state.projectRoot) return true;
  const files = new Map(canonical.files.map((file) => [file.path, file.content]));
  if (Object.entries(snapshot.drafts).some(([file, content]) => files.get(file) !== content)) return true;
  return !!snapshot.config && JSON.stringify(snapshot.config) !== JSON.stringify(canonical.config);
}

/** A refresh may acknowledge the submitted configuration, but never a newer local draft. */
export function refreshedConfig(
  current: ProjectConfig | null,
  previous: UnsavedSnapshot['state'],
  next: Pick<AppState, 'projectRoot' | 'config'>,
  submitted?: ProjectConfig,
): ProjectConfig {
  if (!current || !previous || previous.projectRoot !== next.projectRoot) return next.config;
  const value = JSON.stringify(current);
  return value !== JSON.stringify(previous.config) && value !== JSON.stringify(submitted)
    ? current
    : next.config;
}

/** Saving is asynchronous; typing during a save must result in a new decision. */
export async function saveBeforeAppClose(
  current: () => UnsavedSnapshot,
  save: () => Promise<boolean>,
  readState: () => Promise<AppState>,
): Promise<'saved' | 'changed' | 'failed'> {
  if (hasUnsavedChanges(current()) && !(await save())) return 'failed';
  const canonical = await readState();
  return hasUnsavedChanges(current(), canonical) ? 'changed' : 'saved';
}
