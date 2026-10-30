import type { RuntimePluginInfo, RuntimeViewContribution } from './plugins';

export interface RegisteredRuntimeView extends RuntimeViewContribution {
  pluginId: string;
  key: string;
}
export const runtimeViewKey = (pluginId: string, viewId: string) => `plugin:${pluginId}/${viewId}` as const;
/** Metadata-only registration; revoked or removed packages unregister all their surfaces together. */
export function registeredRuntimeViews(plugins: readonly RuntimePluginInfo[]): RegisteredRuntimeView[] {
  return plugins
    .filter((plugin) => plugin.trust !== 'required' && !plugin.restartRequired)
    .flatMap((plugin) =>
      (plugin.manifest.ui.views ?? []).map((view) => ({
        ...view,
        pluginId: plugin.id,
        key: runtimeViewKey(plugin.id, view.id),
      })),
    );
}
