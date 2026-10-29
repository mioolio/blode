/** Actionable missing prerequisites are warnings; tool, source and runtime failures remain errors. */
export function diagnosticLevel(message: string): 'warning' | 'error' {
  const key = message.match(/^(?:Error: )?([a-zA-Z]+\.[a-zA-Z]+)/)?.[1];
  return key &&
    new Set([
      'toast.noPort',
      'error.selectPort',
      'error.selectDebugProbe',
      'toast.saveFirst',
      'project.openWarning',
      'toast.noBuild',
      'error.buildRequired',
      'error.detectBoardFirst',
      'error.selectCompilePlatform',
      'error.noWorkspace',
      'error.portUnavailable',
      'error.noBuildEntry',
      'error.stm32ProbeRequired',
      'error.selectPlatformForTools',
    ]).has(key)
    ? 'warning'
    : 'error';
}
