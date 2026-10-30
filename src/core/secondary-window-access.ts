/** Secondary renderers expose only the APIs belonging to their approved package. */
export function packageWindowMethodAllowed(
  owner: { kind: 'runtime' | 'extension'; pluginId: string },
  method: unknown,
  args: unknown,
): boolean {
  if (method === 'windowAction') return true;
  if (typeof method !== 'string' || !Array.isArray(args)) return false;
  if (owner.kind === 'extension')
    return (
      [
        'generalExtensionContext',
        'generalExtensionViewDocument',
        'generalExtensionViewUrl',
        'generalExtensionOpenView',
        'generalExtensionConfigure',
      ].includes(method) && args[0]?.id === owner.pluginId
    );
  return (
    method === 'runtimePluginsState' ||
    (method.startsWith('runtimePlugin') &&
      (args[0] === owner.pluginId || (method === 'runtimePluginTrust' && args[0]?.id === owner.pluginId)))
  );
}
