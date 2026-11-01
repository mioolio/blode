const base = require('./electron-builder.config.cjs');
const protectedBuild = process.env.BLODE_PROTECTED === '1';
const { releaseVersion } = require('./package.json');
const path = require('node:path');
if (protectedBuild && !process.env.BLODE_APPLICATION_ROOT) throw new Error('Protected build requires isolated application metadata.');
module.exports = {
  ...base,
  electronDist: require('node:path').dirname(require('electron')),
  ...(protectedBuild ? {
    directories: { ...base.directories, app: process.env.BLODE_APPLICATION_ROOT },
    files: [
      ...base.files.filter((file) => !['config/application.json', 'LICENSE'].includes(file)),
      { from: path.join(__dirname, 'config'), to: 'config', filter: ['application.json'] },
      { from: path.join(__dirname, 'LICENSE'), to: 'LICENSE-CORE' },
    ],
    beforeBuild: (context) => base.beforeBuild({ ...context, appDir: __dirname }),
    copyright: 'Copyright © 2026 Blode Studio. All rights reserved.',
    extraMetadata: {
      ...base.extraMetadata,
      author: { name: 'Blode Studio' },
      description: 'Blode Studio Commercial Distribution',
      license: 'Proprietary',
      distribution: 'commercial-protected',
    },
  } : {}),
  artifactName: `Blode.Studio-${releaseVersion}-${protectedBuild ? 'protected-' : ''}setup-win-x64.\${ext}`,
  win: { ...base.win, target: 'nsis', ...(protectedBuild ? { legalTrademarks: 'Blode Studio' } : {}) },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    // NSIS otherwise injects elevate.exe after the protected payload manifest is signed.
    ...(protectedBuild ? { license: 'build/protected-policy.txt', packElevateHelper: false } : {}),
  },
  afterSign: require('./scripts/installer-signing.cjs').afterSign,
};
