import { createCustomAdapter } from '../../../custom-adapter.js';
import type { RuntimePluginManifest } from '../../../../src/shared/plugins.js';
import declaration from '../manifest.json';
export const customAdapter = createCustomAdapter(declaration as unknown as RuntimePluginManifest);
