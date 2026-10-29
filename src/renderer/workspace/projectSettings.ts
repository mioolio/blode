import type { ProjectBuildInputs, ProjectConfig } from '../../shared/contracts';

export interface ProjectSettingsDraft {
  config: ProjectConfig;
  entry: string;
  files: string;
  cStandard: 'c99' | 'c11' | 'c17' | 'c23';
  build: ProjectBuildInputs;
}

export function readProjectSettings(
  text: string,
  config: ProjectConfig,
  build: ProjectBuildInputs,
): ProjectSettingsDraft {
  const descriptor = text.trim() ? JSON.parse(text) : { ...config, build };
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))
    throw new Error('error.invalidProjectDescriptor');
  const { build: savedBuild = {}, ...savedConfig } = descriptor;
  if (
    typeof savedConfig.name !== 'string' ||
    typeof savedConfig.boardId !== 'string' ||
    !savedConfig.toolchain ||
    !Array.isArray(savedConfig.partitions) ||
    !savedBuild ||
    typeof savedBuild !== 'object' ||
    Array.isArray(savedBuild) ||
    (savedBuild.entry !== undefined && typeof savedBuild.entry !== 'string') ||
    (savedBuild.sketch !== undefined && typeof savedBuild.sketch !== 'string') ||
    (savedBuild.files !== undefined &&
      (!Array.isArray(savedBuild.files) ||
        savedBuild.files.some((file: unknown) => typeof file !== 'string'))) ||
    (savedBuild.cStandard !== undefined && !['c99', 'c11', 'c17', 'c23'].includes(savedBuild.cStandard))
  )
    throw new Error('error.invalidProjectDescriptor');
  return {
    config: savedConfig as ProjectConfig,
    entry: savedBuild.entry ?? savedBuild.sketch ?? '',
    files: (savedBuild.files ?? []).join('\n'),
    cStandard: savedBuild.cStandard ?? 'c17',
    build: savedBuild,
  };
}

export function writeProjectSettings(draft: ProjectSettingsDraft): string {
  const build: ProjectBuildInputs = { ...draft.build, cStandard: draft.cStandard };
  delete build.sketch;
  if (draft.entry.trim()) build.entry = draft.entry.trim();
  else delete build.entry;
  const files = [
    ...new Set(
      draft.files
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (files.length) build.files = files;
  else delete build.files;
  return JSON.stringify({ ...draft.config, build }, null, 2) + '\n';
}
