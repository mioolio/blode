import type { AppState, ProjectConfig } from '../../shared/contracts';

export interface UnsavedSnapshot {
  state: Pick<AppState, 'projectRoot' | 'workspaceOpen' | 'config' | 'files'> | null;
  config: ProjectConfig | null;
  drafts: Record<string, string>;
}

/** Configuration object key order is not an edit. Undefined fields serialize as absent. */
export function sameConfiguration(a: unknown, b: unknown): boolean {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, ordered(item)]),
          )
        : value;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

/** Compare content, not tab ownership or a transient render's dirty counter. */
export function hasUnsavedChanges(snapshot: UnsavedSnapshot, canonical = snapshot.state): boolean {
  if (!snapshot.state?.workspaceOpen) return false;
  if (!canonical || canonical.projectRoot !== snapshot.state.projectRoot) return true;
  const files = new Map(canonical.files.map((file) => [file.path, file.content]));
  if (Object.entries(snapshot.drafts).some(([file, content]) => files.get(file) !== content)) return true;
  return !!snapshot.config && !sameConfiguration(snapshot.config, canonical.config);
}

/** A refresh may acknowledge the submitted configuration, but never a newer local draft. */
export function refreshedConfig(
  current: ProjectConfig | null,
  previous: UnsavedSnapshot['state'],
  next: Pick<AppState, 'projectRoot' | 'config'>,
  submitted?: ProjectConfig,
): ProjectConfig {
  if (!current || !previous || previous.projectRoot !== next.projectRoot) return next.config;
  return !sameConfiguration(current, previous.config) && !sameConfiguration(current, submitted)
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
