import { useSyncExternalStore } from 'react';
import type { GeneralExtensionInfo, GeneralExtensionsState } from '../../shared/general-extensions';
import { generalExtensionPanelKey } from '../../shared/general-extensions';
import type { RuntimeViewContribution } from '../../shared/plugins';

let snapshot: { data?: GeneralExtensionsState; error: string } = { error: '' };
const subscribers = new Set<() => void>();
let off: (() => void) | undefined,
  revision = 0;
const retiredInstances = new Set<string>();
const publish = () => {
  for (const callback of subscribers) callback();
};
export function updateGeneralExtensions(data: GeneralExtensionsState) {
  if (retiredInstances.has(data.instanceId)) return;
  if (snapshot.data?.instanceId === data.instanceId && data.revision < snapshot.data.revision) return;
  if (snapshot.data && snapshot.data.instanceId !== data.instanceId)
    retiredInstances.add(snapshot.data.instanceId);
  revision++;
  snapshot = { data, error: '' };
  publish();
}
export async function refreshGeneralExtensions() {
  const current = ++revision;
  try {
    const data = await window.blode.generalExtensionState();
    if (current === revision) updateGeneralExtensions(data);
  } catch (error) {
    if (current === revision) {
      snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) };
      publish();
    }
  }
}
const focus = () => {
  if (document.visibilityState === 'visible') void refreshGeneralExtensions();
};
const subscribe = (callback: () => void) => {
  subscribers.add(callback);
  if (!off && typeof window !== 'undefined' && typeof window.blode?.generalExtensionState === 'function') {
    const unsubscribe = window.blode.onEvent((event) => {
      if (event.message === 'status.extensionsChanged') void refreshGeneralExtensions();
    });
    document.addEventListener('visibilitychange', focus);
    off = () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', focus);
    };
    void refreshGeneralExtensions();
  }
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      off?.();
      off = undefined;
      revision++;
    }
  };
};
export function useGeneralExtensions() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
export function extensionLabel(
  plugin: GeneralExtensionInfo,
  key: string | undefined,
  fallback: string,
  locale: string,
) {
  return key ? (plugin.locales[locale]?.[key] ?? plugin.locales.en?.[key] ?? fallback) : fallback;
}
export async function openGeneralExtensionView(plugin: GeneralExtensionInfo, view: RuntimeViewContribution) {
  const tab = window.__blodeWeb && view.location === 'window' ? window.open('about:blank', '_blank') : null;
  if (tab) tab.opener = null;
  try {
    const result = await window.blode.generalExtensionOpenView({ id: plugin.id, view: view.id });
    if (result.destination === 'panel')
      window.dispatchEvent(
        new CustomEvent('blode:extension-panel', { detail: generalExtensionPanelKey(plugin.id, view.id) }),
      );
    else if (result.destination === 'browser') {
      if (!tab) throw new Error('error.popupBlocked');
      const url = new URL(window.location.href);
      url.hash = `/extension-view/${encodeURIComponent(plugin.id)}/${encodeURIComponent(view.id)}`;
      tab.location.replace(url.href);
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}
export function useExtensionMenus(locale: string) {
  const { data } = useGeneralExtensions(),
    active = (data?.plugins ?? []).filter((plugin) => plugin.enabled);
  const overrides = Object.assign(
    {},
    ...active.map((plugin) =>
      Object.fromEntries(
        Object.entries(plugin.appearance?.menuOverrides ?? {}).map(([id, value]) => [
          id,
          {
            ...value,
            ...(value.label ? { label: extensionLabel(plugin, value.label, value.label, locale) } : {}),
          },
        ]),
      ),
    ),
  ) as Record<string, { label?: string; icon?: string }>;
  const items = active.flatMap((plugin) =>
    (plugin.manifest.ui.menus ?? []).map((menu) => ({
      id: `${plugin.id}/${menu.id}`,
      label: extensionLabel(plugin, menu.labelKey, menu.label, locale),
      icon: menu.icon,
      run: () => {
        const view = plugin.manifest.ui.views?.find((view) => view.id === menu.view);
        if (view)
          void openGeneralExtensionView(plugin, view).catch((error) =>
            window.dispatchEvent(
              new CustomEvent('blode:extension-error', {
                detail: error instanceof Error ? error.message : String(error),
              }),
            ),
          );
      },
    })),
  );
  return { overrides, items };
}
/** Restore previous inline values on disable/uninstall, leaving the base theme intact. */
export function applyShellAppearance(
  root: HTMLElement,
  plugins: readonly GeneralExtensionInfo[],
): () => void {
  const before = new Map<string, { value: string; priority: string }>();
  const assign = (key: string, value: string) => {
    if (!before.has(key))
      before.set(key, {
        value: root.style.getPropertyValue(key),
        priority: root.style.getPropertyPriority(key),
      });
    root.style.setProperty(key, value);
  };
  const classes = new Map(
    ['extension-glass', 'extension-wallpaper', 'extension-desktop-glass'].map((name) => [
      name,
      root.classList.contains(name),
    ]),
  );
  let glass = false,
    wallpaper = false,
    desktopGlass = false;
  for (const plugin of plugins.filter((plugin) => plugin.enabled)) {
    const appearance = plugin.appearance;
    if (!appearance) continue;
    for (const [key, value] of Object.entries(appearance.variables ?? {})) assign(key, value);
    if (appearance.blur !== undefined) assign('--extension-blur', `${appearance.blur}px`);
    glass = appearance.translucent ?? glass;
    desktopGlass = appearance.desktopGlass ?? desktopGlass;
    if (
      appearance.backgroundData &&
      /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(appearance.backgroundData)
    ) {
      assign('--extension-background-image', `url("${appearance.backgroundData}")`);
      wallpaper = true;
    }
  }
  root.classList.toggle('extension-glass', glass);
  root.classList.toggle('extension-wallpaper', wallpaper);
  root.classList.toggle(
    'extension-desktop-glass',
    desktopGlass && !(typeof window !== 'undefined' && window.__blodeWeb),
  );
  return () => {
    for (const [key, value] of before)
      value.value ? root.style.setProperty(key, value.value, value.priority) : root.style.removeProperty(key);
    for (const [name, existed] of classes) root.classList.toggle(name, existed);
  };
}
