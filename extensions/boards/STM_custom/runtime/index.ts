import { createCustomRuntime } from '../../../custom-runtime.js';
import { createCustomAdapter } from '../../../custom-adapter.js';
import type { RuntimeHost } from '../../../runtime.js';
import type { RuntimePluginManifest } from '../../../../src/shared/plugins.js';
import declaration from '../manifest.json';
export function createRuntime(host: RuntimeHost, manifest = declaration as unknown as RuntimePluginManifest) {
  return createCustomRuntime(host, createCustomAdapter(manifest));
}
