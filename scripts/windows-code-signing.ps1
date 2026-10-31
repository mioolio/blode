param([ValidateSet('Init','Sign')][string]$Action = 'Init', [string]$TargetFile, [switch]$ReplaceSignature)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$signingRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.signing'))
$settingsFile = Join-Path $signingRoot 'windows-signing.json'
if ($Action -eq 'Init') {
  if (Test-Path -LiteralPath $settingsFile) { throw 'Windows signing identity already exists.' }
  if (!(Test-Path -LiteralPath $signingRoot)) { throw 'Initialize the OBE signing directory first.' }
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Blode Studio, O=Blode Studio' -FriendlyName 'Blode Studio Release Signing' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3)
  $randomBytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($randomBytes)
  $passwordText = [Convert]::ToBase64String($randomBytes)
  $password = ConvertTo-SecureString -String $passwordText -AsPlainText -Force
  Export-PfxCertificate -Cert $certificate -FilePath (Join-Path $signingRoot 'blode-studio.pfx') -Password $password | Out-Null
  Export-Certificate -Cert $certificate -FilePath (Join-Path $signingRoot 'blode-studio.cer') | Out-Null
  @{ thumbprint = $certificate.Thumbprint; password = $passwordText; subject = $certificate.Subject } | ConvertTo-Json | Set-Content -LiteralPath $settingsFile -Encoding UTF8
  Write-Output ('Created self-signed Windows identity: ' + $certificate.Subject)
} else {
  if (!(Test-Path -LiteralPath $settingsFile)) { throw 'Windows signing identity is missing.' }
  $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
  $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $settings.thumbprint) -ErrorAction SilentlyContinue
  if (!$certificate -or !$certificate.HasPrivateKey) {
    $password = ConvertTo-SecureString -String $settings.password -AsPlainText -Force
    $certificate = Import-PfxCertificate -FilePath (Join-Path $signingRoot 'blode-studio.pfx') -CertStoreLocation 'Cert:\CurrentUser\My' -Password $password
  }
  $fullTarget = [IO.Path]::GetFullPath($TargetFile)
  if (@('.exe','.dll') -notcontains [IO.Path]::GetExtension($fullTarget).ToLowerInvariant()) { throw 'Only PE EXE and DLL files are supported.' }
  $existing = Get-AuthenticodeSignature -LiteralPath $fullTarget
  if (!$ReplaceSignature -and $existing.SignerCertificate -and $existing.SignerCertificate.Thumbprint -ne $settings.thumbprint) {
    Write-Output ('Preserved existing publisher signature: ' + $existing.SignerCertificate.Subject)
    exit 0
  }
  $result = Set-AuthenticodeSignature -LiteralPath $fullTarget -Certificate $certificate -HashAlgorithm SHA256
  $checked = Get-AuthenticodeSignature -LiteralPath $fullTarget
  if (!$checked.SignerCertificate -or $checked.SignerCertificate.Thumbprint -ne $settings.thumbprint -or $checked.Status -eq 'HashMismatch' -or $checked.Status -eq 'NotSigned') { throw ('Signing failed: ' + $result.StatusMessage) }
  Write-Output ('Windows signature: ' + $checked.Status + ' (self-signed Blode Studio identity)')
}
