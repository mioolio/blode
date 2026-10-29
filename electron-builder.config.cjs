/**
 * electron-builder configuration for the two packaging modes.
 *
 * `npm run package:lite` keeps the download-on-demand model: only the app, board
 * manifests, docs and the ST-Link driver archive are shipped, and missing tools
 * are installed into the user data folder on first use.
 *
 * `npm run package:full` additionally ships the local `tools/` toolchains
 * (Arduino CLI, Arduino-ESP32 core, ST-Link, Arm Compiler 6) so a fresh machine
 * can compile without installing anything else. Anything already missing at
 * runtime can still be installed through the normal setup flow or a custom path.
 */
const full = process.env.npm_lifecycle_event === 'package:full' || process.env.BLODE_BUNDLE_TOOLS === '1';

/**
 * Skipped inside the bundled Arduino data folder: `tmp` is a cache and the
 * library index is rebuilt by `arduino-cli core update-index`. The other local
 * artefacts (`python` venv link, `downloads`, `arduino-cli.yaml` with this
 * machine's paths and proxy) live outside the copied folders entirely.
 */
const arduinoDataFilter = ['**/*', '!tmp/**', '!library_index.json', '!library_index.json.sig'];

const bundledTools = full
  ? [
      { from: 'tools/armclang', to: 'tools/armclang' },
      { from: 'tools/bin', to: 'tools/bin' },
      { from: 'tools/stlink', to: 'tools/stlink' },
      { from: 'tools/libraries', to: 'tools/libraries' },
      { from: 'tools/arduino-data', to: 'tools/arduino-data', filter: arduinoDataFilter },
    ]
  : [];

module.exports = {
  appId: 'studio.blode.desktop',
  productName: 'Blode Studio',
  directories: { output: full ? 'release/full' : 'release/lite' },
  files: ['dist/**/*', 'package.json'],
  extraResources: [
    { from: 'docs', to: 'docs' },
    { from: 'extensions/boards', to: 'boards', filter: ['*/manifest.json'] },
    { from: 'tools/STSW-LINK', to: 'drivers/STSW-LINK' },
    ...bundledTools,
  ],
  asarUnpack: ['**/*.node'],
  artifactName: `Blode.Studio-\${version}-win-x64-${full ? 'full' : 'lite'}.\${ext}`,
  win: {
    // A 3+ GiB portable executable would unpack itself on every launch, so the
    // full build is published as a plain, directly runnable folder archive.
    target: full ? 'zip' : 'portable',
  },
};
