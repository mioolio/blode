/**
 * One command-line description for the source host and the packaged
 * executable. Keeping it here prevents the two editions from drifting.
 */
export function webCliHelp(version: string, options: { program: string; launcher?: boolean }): string {
  const launcherLines = options.launcher
    ? '  --no-open                   Do not open the default browser on start\n' +
      '  --version                   Print the release version and exit\n'
    : '';
  return [
    `Blode Studio Web host ${version} (Node.js 24+, no Electron)`,
    `Usage: ${options.program} [options]`,
    '  --host 127.0.0.1|0.0.0.0  Bind address (default: 127.0.0.1)',
    '  --port <0-65535>            HTTP port (default: 47821; 0 selects a free port)',
    '  --project <directory>       Open a directory on this host at startup',
    '  --data-root <directory>     Host settings, credentials, history and downloaded tools',
    ...(launcherLines ? launcherLines.trimEnd().split('\n') : []),
    '  --help                     Show this help',
    '',
  ].join('\n');
}
