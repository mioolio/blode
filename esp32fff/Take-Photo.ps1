param(
    [string]$Port = 'COM3',
    [ValidateSet('QVGA','VGA','SVGA','XGA','UXGA','QXGA','QSXGA','FULL5MP')]
    [string]$Resolution = 'FULL5MP'
)
$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '..\tools\python\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }
& $python (Join-Path $PSScriptRoot 'capture.py') --port $Port --resolution $Resolution --reset
exit $LASTEXITCODE
