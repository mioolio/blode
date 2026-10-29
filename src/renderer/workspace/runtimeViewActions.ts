import type { RuntimeViewContribution } from '../../shared/plugins';
import { runtimeViewKey } from '../../shared/runtime-views';

/** Reserve a browser tab within the user's click, before the authenticated host request. */
export async function openRuntimeContribution(pluginId: string, view: RuntimeViewContribution) {
  const tab = window.__blodeWeb && view.location === 'window' ? window.open('about:blank', '_blank') : null;
  if (tab) tab.opener = null;
  try {
    const result = await window.blode.runtimePluginOpenView(pluginId, view.id);
    if (result.destination === 'panel')
      window.dispatchEvent(
        new CustomEvent('blode:runtime-panel', { detail: runtimeViewKey(pluginId, view.id) }),
      );
    else if (result.destination === 'browser') {
      if (!tab) throw new Error('error.popupBlocked');
      if (!result.url || !/^https?:$/.test(new URL(result.url).protocol))
        throw new Error('error.runtimePluginResult');
      tab.location.replace(result.url);
    }
    return result;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
