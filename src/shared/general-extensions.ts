import type { RuntimePluginField, RuntimeViewContribution } from './plugins';

export const extensionPermissions = [
  'ui.appearance',
  'ui.menus',
  'ui.windows',
  'ui.panels',
  'settings',
  'native',
] as const;
export type ExtensionPermission = (typeof extensionPermissions)[number];
export type ExtensionValues = Record<string, string | number | boolean>;
export interface ExtensionAppearance {
  variables?: Record<string, string>;
  background?: string;
  blur?: number;
  translucent?: boolean;
  /** Let the native desktop material show through the workbench chrome. */
  desktopGlass?: boolean;
  menuOverrides?: Record<string, { label?: string; icon?: string }>;
}
export interface GeneralExtensionManifest {
  apiVersion: 1;
  kind: 'extension';
  id: string;
  name: string;
  version: string;
  description?: string;
  vendor?: string;
  documentation?: string;
  /** Optional native ESM entry. Requires native permission and explicit package trust. */
  runtime?: string;
  permissions: ExtensionPermission[];
  locales?: Record<string, string>;
  settings?: { defaults?: string; fields: RuntimePluginField[] };
  ui: {
    menus?: { id: string; label: string; labelKey?: string; icon?: string; view: string }[];
    views?: RuntimeViewContribution[];
    appearance?: ExtensionAppearance;
    presets?: { id: string; label: string; appearance: ExtensionAppearance }[];
    presetSetting?: string;
    /** Boolean setting that toggles `appearance.desktopGlass` at runtime. */
    desktopGlassSetting?: string;
  };
}
export interface GeneralExtensionInfo {
  id: string;
  directory: string;
  fingerprint: string;
  enabled: boolean;
  trust: 'required' | 'session' | 'permanent';
  restartRequired?: boolean;
  manifest: GeneralExtensionManifest;
  settings: ExtensionValues;
  locales: Record<string, Record<string, string>>;
  appearance?: ExtensionAppearance & { backgroundData?: string };
}
export interface GeneralExtensionsState {
  instanceId: string;
  revision: number;
  directory: string;
  plugins: GeneralExtensionInfo[];
  errors: { directory: string; message: string }[];
  examples: { id: string; name: string; path: string }[];
}
export interface ExtensionReview {
  verification?: import('./package-signing').PackageVerification;
  ticket: string;
  fingerprint: string;
  manifest: GeneralExtensionManifest;
  files: string[];
  bytes: number;
}
export interface GeneralExtensionsApi {
  generalExtensionState(): Promise<GeneralExtensionsState>;
  generalExtensionReview(request: { path: string }): Promise<ExtensionReview>;
  generalExtensionInstall(request: {
    approval?: import('./package-signing').PackageApproval;
    ticket: string;
    fingerprint: string;
    confirm: true;
  }): Promise<GeneralExtensionsState>;
  generalExtensionEnable(request: {
    id: string;
    fingerprint: string;
    confirm: true;
    permanent: boolean;
  }): Promise<GeneralExtensionsState>;
  generalExtensionDisable(request: { id: string }): Promise<GeneralExtensionsState>;
  generalExtensionRemove(request: { id: string; confirm: true }): Promise<GeneralExtensionsState>;
  generalExtensionConfigure(request: {
    id: string;
    values: ExtensionValues;
  }): Promise<GeneralExtensionsState>;
  generalExtensionExport(request: {
    id: string;
    confirm: true;
  }): Promise<{ id: string; name: string; size: number }>;
  generalExtensionPackageSave(id: string): Promise<boolean>;
  generalExtensionViewDocument(request: { id: string; view: string }): Promise<string>;
  generalExtensionViewUrl(request: { id: string; view: string }): Promise<string>;
  generalExtensionOpenView(request: {
    id: string;
    view: string;
  }): Promise<{ destination: 'window' | 'browser' | 'panel'; url?: string }>;
  generalExtensionContext(request: { id: string }): Promise<GeneralExtensionInfo>;
}
export const generalExtensionPanelKey = (id: string, view: string) => `plugin:ext-${id}/${view}` as const;
