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
const { releaseVersion } = require('./package.json');
const releaseDist = process.env.BLODE_RELEASE_DIST;
if (!/^\d+\.\d+\.\d+\.\d+$/.test(releaseVersion)) throw new Error('A four-part releaseVersion is required.');

/**
 * Skipped inside the bundled Arduino data folder: `tmp` is a cache and the
 * library index is rebuilt by `arduino-cli core update-index`. The other local
 * artefacts (`python` venv link, `downloads`, `arduino-cli.yaml` with this
 * machine's paths and proxy) live outside the copied folders entirely.
 */
const fs = require('node:fs');
const arduinoDataFilter = ['**/*', '!tmp/**', '!library_index.json', '!library_index.json.sig'];

// Full packages also ship clangd when the maintainer fetched it into tools/.
// Lite packages omit it and install it from Preferences on first use.
const bundledTools = full
  ? [
      { from: 'tools/armclang', to: 'tools/armclang' },
      { from: 'tools/bin', to: 'tools/bin' },
      { from: 'tools/stlink', to: 'tools/stlink' },
      { from: 'tools/libraries', to: 'tools/libraries' },
      { from: 'tools/arduino-data', to: 'tools/arduino-data', filter: arduinoDataFilter },
      ...(fs.existsSync('tools/clangd') ? [{ from: 'tools/clangd', to: 'tools/clangd' }] : []),
      ...(fs.existsSync('tools/versions/armcc')
        ? [
            {
              from: 'tools/versions/armcc',
              to: 'tools/versions/armcc',
              filter: ['**/*', '!**/*.lic', '!**/*.licx', '!**/*.key', '!**/*.pem', '!**/TOOLS.INI'],
            },
          ]
        : []),
    ]
  : [];

module.exports = {
  appId: 'studio.blode.desktop',
  productName: 'Blode Studio',
  buildVersion: releaseVersion,
  buildNumber: releaseVersion.split('.').at(-1),
  extraMetadata: { releaseVersion, shortVersionWindows: releaseVersion },
  directories: { output: `release/${releaseVersion}${full ? '/full' : ''}` },
  files: [
    ...(releaseDist
      ? [
          {
            // Copy the whole staged output; listing individual paths here
            // dropped the renderer directory from the app archive.
            from: releaseDist,
            to: 'dist',
            filter: ['**/*', '!**/*.map', '!device-modules/**'],
          },
        ]
      : [
          'dist/main.cjs',
          'dist/preload.cjs',
          'dist/mcp-bridge.mjs',
          'dist/renderer/**/*',
          'dist/archive-tools/**/*',
        ]),
    'config/application.json',
    'package.json',
    'LICENSE',
    '!**/*.map',
    {
      // beforeBuild=false also disables electron-builder's dependency collector.
      // The verified branch stages this exact runtime closure; fallback leaves it empty.
      from: process.env.BLODE_NATIVE_STAGE_ROOT
        ? require('node:path').join(process.env.BLODE_NATIVE_STAGE_ROOT, '${os}-${arch}')
        : '.tools/native-runtime-stage/${os}-${arch}',
      to: 'node_modules',
      filter: ['**/*', '!**/*.map'],
    },
  ],
  extraResources: [
    { from: require('node:path').join(releaseDist || 'dist', 'device-modules'), to: 'device-modules' },
    {
      from: 'extensions/plugins',
      to: 'extensions/plugins',
      filter: [
        '**/*',
        '!**/.vscode/**',
        '!**/.git/**',
        '!**/.tools/**',
        '!**/.env*',
        '!**/.uel',
        '!**/node_modules/**',
      ],
    },
    { from: 'docs', to: 'docs' },
    { from: 'extensions/boards', to: 'boards', filter: ['*/manifest.json'] },
    { from: 'tools/STSW-LINK', to: 'drivers/STSW-LINK' },
    ...bundledTools,
  ],
  asarUnpack: ['**/*.node', '**/node-pty/**/*'],
  artifactName: `Blode.Studio-${releaseVersion}-desktop${full ? '-full' : ''}-win-x64.\${ext}`,
  publish: null,
  beforeBuild: require('./scripts/native-runtime.cjs').beforeBuild,
  afterPack: require('./scripts/windows-package-integrity.cjs').afterPack,
  afterAllArtifactBuild: require('./scripts/windows-package-integrity.cjs').afterAllArtifactBuild,
  win: {
    // A 3+ GiB portable executable would unpack itself on every launch, so the
    // full build is published as a plain, directly runnable folder archive.
    target: full ? 'zip' : 'portable',
  },
};
