# Build the Windows MSI.
#   build-msi.ps1 -Version 1.0.0 -Arch x64 -Binary dist\standalone\ghostrow.exe -OutDir out
# Needs the WiX CLI: dotnet tool install --global wix
# Output: <OutDir>\ghostrow-<Version>-windows-<Arch>.msi
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Arch,
  [Parameter(Mandatory = $true)][string]$Binary,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Binary)) { throw "Binary not found: $Binary" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# MSI versions are numeric (major.minor.build); drop any pre-release or build suffix.
$msiVersion = ($Version -split '[-+]')[0]
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$outFile = Join-Path (Resolve-Path -LiteralPath $OutDir).Path "ghostrow-$Version-windows-$Arch.msi"
$wxs = Join-Path $PSScriptRoot 'ghostrow.wxs'

wix build -arch $Arch -d "Version=$msiVersion" -d "Binary=$binaryPath" -o $outFile $wxs
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
Write-Host "wrote $outFile"
