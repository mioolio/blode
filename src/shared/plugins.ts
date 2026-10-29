import type { ProjectConfig } from './contracts';

export type RuntimeTransport = 'serial' | 'stlink' | 'usb' | 'physical' | 'custom';
export type RuntimeViewKind = 'debugger' | 'device' | `view:${string}`;
export const RUNTIME_VIEW_KIND_PATTERN = /^(?:debugger|device|view:[A-Za-z][A-Za-z0-9_-]{0,79})$/;
export interface RuntimeViewContribution {
  id: string;
  label: string;
  file: string;
  location: 'window' | 'panel';
  width?: number;
  height?: number;
}
export const isRuntimeViewKind = (value: unknown): value is RuntimeViewKind =>
  typeof value === 'string' && RUNTIME_VIEW_KIND_PATTERN.test(value);
export interface RuntimePluginTool {
  id: string;
  executable: string;
  runner?: 'native' | 'node';
  version?: string;
  args?: string[];
}
export interface RuntimePluginField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}
/** Declarative metadata is inspected before any package JavaScript is imported. */
export interface RuntimePluginManifest {
  apiVersion: 2;
  runtimeApiVersion: 2;
  kind: 'board';
  id: string;
  name: string;
  version: string;
  runtime: string;
  vendor?: string;
  description?: string;
  descriptionKey?: string;
  documentation?: string;
  transport: RuntimeTransport;
  capabilities: string[];
  sourceInputs?: string[];
  support: {
    chips: string[];
    families?: string[];
    status: 'experimental' | 'supported';
    notes?: string;
  };
  defaultConfig: ProjectConfig;
  compiler: {
    mode: 'host' | 'plugin' | 'runtime';
    baseRuntime?: string;
    defaultTool?: RuntimePluginTool;
    /** Default tools installed and discovered by this runtime's install/status methods. */
    managedTools?: { id: string; name: string; version?: string }[];
    forceComponent?: boolean;
  };
  debugger: { mode: 'none' | 'builtin' | 'extend' | 'replace'; view?: string };
  languages?: import('./module-languages').ModuleLanguagesDeclaration;
  layout: {
    flashBaseAddress?: number;
    recommendedFlashSizes: number[];
    possibleFlashSizes?: number[];
    ramSize: number;
  };
  constraints: { chipIds?: string[]; notes?: string[] };
  ui: {
    fields: RuntimePluginField[];
    hiddenCapabilities?: string[];
    view?: string;
    actions?: { id: string; label: string; confirm?: boolean }[];
    views?: RuntimeViewContribution[];
  };
}
export interface RuntimePluginInfo {
  id: string;
  name: string;
  directory: string;
  fingerprint: string;
  trust: 'required' | 'session' | 'permanent';
  restartRequired?: boolean;
  manifest: RuntimePluginManifest;
}
export interface RuntimePluginsState {
  plugins: RuntimePluginInfo[];
  errors: { directory: string; message: string }[];
}
export interface RuntimePluginTrustRequest {
  id: string;
  fingerprint: string;
  confirm: true;
  permanent: boolean;
}
export interface RuntimePluginsApi {
  runtimePluginViewInfo(id: string, viewId: string): Promise<RuntimeViewContribution>;
  runtimePluginOpenView(
    id: string,
    viewId: string,
  ): Promise<{ destination: 'window' | 'browser' | 'panel'; url?: string }>;
  runtimePluginViewDocument(id: string, kind: RuntimeViewKind): Promise<string | null>;
  runtimePluginContext(id: string): Promise<{
    deviceId: string;
    values: Record<string, string | number | boolean>;
    capabilities: string[];
    support: RuntimePluginManifest['support'];
    layout: RuntimePluginManifest['layout'];
  }>;
  runtimePluginConfigure(
    id: string,
    value: Pick<NonNullable<ProjectConfig['runtime']>, 'deviceId' | 'values' | 'disabledCapabilities'>,
  ): Promise<void>;
  runtimePluginsState(): Promise<RuntimePluginsState>;
  runtimePluginTrust(request: RuntimePluginTrustRequest): Promise<RuntimePluginsState>;
  runtimePluginView(id: string, kind: RuntimeViewKind): Promise<string | null>;
  runtimePluginDebug(id: string, method: string, args: unknown[]): Promise<unknown>;
  runtimePluginDevice(id: string, method: string, args: unknown[], confirm?: true): Promise<unknown>;
}
