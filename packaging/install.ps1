# Ghostrow installer for Windows (PowerShell 5.1 or later).
#   irm https://ghostrow.com/install.ps1 | iex
# Environment: GHOSTROW_VERSION, GHOSTROW_INSTALL, GHOSTROW_NO_MODIFY_PATH=1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

function Install-Ghostrow {
  $repo = 'ghostrowlabs/ghostrow'

  $archName = $env:PROCESSOR_ARCHITEW6432
  if (-not $archName) { $archName = $env:PROCESSOR_ARCHITECTURE }
  if ($archName -eq 'AMD64') { $arch = 'x64' }
  elseif ($archName -eq 'ARM64') { $arch = 'arm64' }
  else { throw "Unsupported CPU architecture '$archName'. Ghostrow ships for x64 and arm64." }

  $version = $env:GHOSTROW_VERSION
  if (-not $version) {
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest"
    $version = $release.tag_name
  }
  $version = "$version".TrimStart('v')
  if (-not $version) { throw 'Could not determine the latest version. Set GHOSTROW_VERSION and try again.' }

  $asset = "ghostrow-$version-windows-$arch.zip"
  $base = "https://github.com/$repo/releases/download/v$version"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ghostrow-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null

  try {
    Write-Host "Downloading Ghostrow $version for Windows $arch"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

    $expected = $null
    foreach ($line in (Get-Content (Join-Path $tmp 'SHA256SUMS'))) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0]; break }
    }
    if (-not $expected) { throw "$asset is not listed in SHA256SUMS." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $asset)).Hash
    if ($actual.ToLower() -ne $expected.ToLower()) {
      throw "Checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."
    }
    Write-Host 'Checksum verified'

    $root = $env:GHOSTROW_INSTALL
    if (-not $root) { $root = Join-Path $env:USERPROFILE '.ghostrow' }
    $binDir = Join-Path $root 'bin'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null

    $unpack = Join-Path $tmp 'unpack'
    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $unpack -Force
    Copy-Item -Force -Path (Join-Path $unpack 'ghostrow.exe') -Destination (Join-Path $binDir 'ghostrow.exe')
    Write-Host "Installed $binDir\ghostrow.exe"

    if ($env:GHOSTROW_NO_MODIFY_PATH -eq '1') {
      Write-Host "Left your PATH alone (GHOSTROW_NO_MODIFY_PATH=1). Add $binDir to your PATH yourself."
    } else {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (-not $userPath) { $userPath = '' }
      $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
      if ($entries -notcontains $binDir) {
        $newPath = ($entries + $binDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Added $binDir to your user PATH"
      }
      if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
    }

    Write-Host ''
    Write-Host 'Done. Open a new terminal if ghostrow is not found, then try:'
    Write-Host '  ghostrow --version'
    Write-Host '  ghostrow seed --schema schema.sql --dry-run'
    Write-Host 'Docs: https://ghostrow.com/docs/quickstart'
  }
  finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
  }
}

Install-Ghostrow
