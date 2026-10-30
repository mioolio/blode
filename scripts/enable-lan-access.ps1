param([ValidateRange(1,65535)][int]$Port = 47821)
$ErrorActionPreference = 'Stop'
$connection = Get-NetTCPConnection -State Listen -LocalPort $Port | Select-Object -First 1
if (-not $connection) { throw "No service is listening on TCP $Port." }
$serviceProcess = Get-Process -Id $connection.OwningProcess
$program = $serviceProcess.Path
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$knownPrograms = @(
    (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'),
    (Get-Command node.exe -ErrorAction SilentlyContinue).Source
)
if ($program -notin $knownPrograms -and $serviceProcess.ProcessName -ne 'Blode Studio') {
    throw "TCP $Port is not owned by a Blode, Node.js or workspace Electron service."
}
$ruleName = "BlodeStudio-LAN-TCP-$Port"
$rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($rule) {
    $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any
    $rule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $program
    $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
    $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet
} else {
    New-NetFirewallRule -Name $ruleName -DisplayName "Blode Studio LAN (TCP $Port)" -Enabled True -Direction Inbound -Action Allow -Profile Any -Program $program -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null
}
Write-Output "Blode Studio LAN access enabled on TCP $Port for LocalSubnet."
