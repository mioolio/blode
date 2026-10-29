import { existsSync } from 'node:fs';
import path from 'node:path';

/** Prompt metadata is an internal OSC, not executable code received from the terminal. */
export function terminalShell(
  session: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].filter(Boolean) as string[];
    const candidates = [
      ...roots.map((root) => path.join(root, 'PowerShell', '7', 'pwsh.exe')),
      ...(env.PATH ?? env.Path ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((root) => path.join(root, 'pwsh.exe')),
    ];
    const executable =
      candidates.find((file) => existsSync(file)) ??
      path.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const integration = `
$global:__BlodeUtf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $global:__BlodeUtf8
[Console]::OutputEncoding = $global:__BlodeUtf8
$global:OutputEncoding = $global:__BlodeUtf8
& "$env:SystemRoot\\System32\\chcp.com" 65001 > $null
Import-Module PSReadLine -ErrorAction SilentlyContinue
$global:__BlodeExecution = 0
$global:__BlodeExecuting = $false
function global:prompt {
  $ok = $?
  $code = 0
  if (-not $ok) { $code = 1; if ($global:LASTEXITCODE) { $code = $global:LASTEXITCODE } }
  $executed = [int][bool]$global:__BlodeExecuting
  $global:__BlodeExecuting = $false
  $location = (Get-Location).Path
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($location))
  $marker = ([char]27)+']777;BL0DE;${session};P;'+$global:__BlodeExecution+';'+$code+';'+$encoded+';'+$executed+([char]7)
  $marker+'PS '+$location+'> '
}
if (Get-Module PSReadLine) {
  $global:__BlodeReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = $global:__BlodeReadLine.Invoke()
    $global:__BlodeExecution++
    $global:__BlodeExecuting = $true
    [Console]::Write(([char]27)+']777;BL0DE;${session};B;'+$global:__BlodeExecution+';'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$line))+([char]7))
    $line
  }
}
`;
    return {
      executable,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-EncodedCommand',
        Buffer.from(integration, 'utf16le').toString('base64'),
      ],
      initialize: '',
    };
  }
  const executable = env.SHELL && path.isAbsolute(env.SHELL) && existsSync(env.SHELL) ? env.SHELL : '/bin/sh';
  const name = path.basename(executable);
  const prompt = `printf '\\033]777;BL0DE;${session};%s;%s\\007' "$__blode_exit" "$(printf '%s' "$PWD" | base64 | tr -d '\\n')"`;
  let initialize = `PS1='$ '; `;
  if (name.includes('bash'))
    initialize = `__blode_prompt(){ __blode_exit=$?; ${prompt}; }; PROMPT_COMMAND=__blode_prompt; `;
  else if (name.includes('zsh'))
    initialize = `__blode_prompt(){ __blode_exit=$?; ${prompt}; }; precmd_functions+=(__blode_prompt); `;
  else if (name === 'fish')
    initialize = `function fish_prompt; set -l __blode_exit $status; printf '\\033]777;BL0DE;${session};%s;%s\\007' $__blode_exit (printf '%s' $PWD | base64 | string join ''); printf '%s> ' $PWD; end; `;
  else {
    const value = `$( __blode_exit=$?; ${prompt} )$ `;
    initialize = `PS1='${value.replaceAll("'", "'\\''")}'; `;
  }
  return { executable, args: ['-i'], initialize };
}
