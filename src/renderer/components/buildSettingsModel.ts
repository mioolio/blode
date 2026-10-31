import type { BuildSettings, CompilerChoice } from '../../shared/build-settings';

export type BuildCompilerLanguage = 'common' | 'c' | 'cpp';

/** Present one compiler context while preserving the descriptor's inheritance rules. */
export function buildCompilerChoice(
  settings: BuildSettings,
  platform: string | undefined,
  language: BuildCompilerLanguage,
): CompilerChoice | undefined {
  const scoped = platform && platform !== 'auto' ? settings.platforms?.[platform] : undefined;
  return language === 'common' ? (scoped?.common ?? settings.common) : scoped?.[language];
}

export function updateBuildCompilerChoice(
  settings: BuildSettings,
  platform: string | undefined,
  language: BuildCompilerLanguage,
  choice: CompilerChoice,
): BuildSettings {
  if (!platform || platform === 'auto')
    return language === 'common' ? { ...settings, common: choice } : settings;
  return {
    ...settings,
    platforms: {
      ...settings.platforms,
      [platform]: { ...settings.platforms?.[platform], [language]: choice },
    },
  };
}
