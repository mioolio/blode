import type { LanguageExternalSource } from '../../shared/language';

/** Keep open SDK tabs in step with refreshed Peek models, within the same workspace. */
export function externalSourceUpdate(
  files: Record<string, LanguageExternalSource>,
  root: string,
  detail: unknown,
): Record<string, LanguageExternalSource> {
  if (!root || !detail || typeof detail !== 'object') return files;
  const update = detail as { root?: unknown; source?: Partial<LanguageExternalSource> };
  const source = update.source;
  if (
    update.root !== root ||
    !source ||
    source.readonly !== true ||
    source.language !== 'cpp' ||
    typeof source.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(source.id) ||
    typeof source.path !== 'string' ||
    !source.path.startsWith(`@external/${source.id}/`) ||
    typeof source.name !== 'string' ||
    typeof source.displayPath !== 'string' ||
    typeof source.content !== 'string'
  )
    return files;
  const previous = files[source.path];
  if (
    previous?.id === source.id &&
    previous.content === source.content &&
    previous.name === source.name &&
    previous.displayPath === source.displayPath
  )
    return files;
  return { ...files, [source.path]: source as LanguageExternalSource };
}
