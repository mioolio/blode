import type { PlatformRuntime, RuntimeHost } from './runtime.js';
import type { RuntimePluginManifest } from '../src/shared/plugins.js';

export interface PluginRuntimeHost extends RuntimeHost {
  pluginRoot: string;
  /** Request one of this package's declared surfaces after authorization. */
  openView(viewId: string): Promise<void>;
  defaultTool?: {
    id: string;
    command: string;
    args: string[];
    version?: string;
    env?: NodeJS.ProcessEnv;
  };
  runDefaultTool(extraArgs?: string[]): ReturnType<RuntimeHost['runCommand']>;
}
export interface PluginPlatformRuntime extends PlatformRuntime {
  debugger?: Record<string, (...args: any[]) => unknown | Promise<unknown>>;
  device?: Record<string, (...args: any[]) => unknown | Promise<unknown>>;
  dispose?(): void | Promise<void>;
}
export interface RuntimePluginModule {
  createRuntime(
    host: PluginRuntimeHost,
    manifest: RuntimePluginManifest,
  ): PluginPlatformRuntime | Promise<PluginPlatformRuntime>;
}
