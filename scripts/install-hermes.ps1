#requires -Version 7.4
<#
.SYNOPSIS
  Installs the pinned Hermes VM (the JavaScript engine React Native uses) for test/module/hermes.test.ts.
.DESCRIPTION
  Downloads the Hermes CLI for this OS (Linux x64, macOS universal, Windows x64, which Windows on ARM64 runs emulated) from Hermes's own GitHub release,
  checks its SHA-256 against the hash pinned here, and unpacks it to node_modules/.cache/hermes (hermes or
  hermes.exe, beside the DLLs the Windows build needs). Does nothing if that version is already there.
  v0.13.0 is the latest Hermes release with prebuilt CLI binaries (the engine React Native 0.75 ships); later Hermes
  versions are only published inside React Native's own builds, and the hermes-compiler npm package has the bytecode
  compiler only, no VM.
  In GitHub Actions, sets HERMES_PATH for the later steps, so that the test fails instead of being skipped if the binary
  is missing. Locally, the test finds the binary in node_modules/.cache/hermes, and is skipped until this script has
  run.
  Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-hermes.ps1
#>
. (Join-Path $PSScriptRoot ci-helpers.ps1)

$version = 'v0.13.0'
$assets = @{
  # SHA-256 of each asset of https://github.com/facebook/hermes/releases/tag/v0.13.0.
  windows = @{ Name = 'hermes-cli-windows.tar.gz'; Sha256 = '485907ae87f267f7901f45c12979fea9703967ee2fa930bab887d022de9d6478'; Binary = 'hermes.exe' }
  darwin = @{ Name = 'hermes-cli-darwin.tar.gz'; Sha256 = 'f16b0214f7b96eccbd47766f5a3914e847a4387649b2f6b60820d309879200bd'; Binary = 'hermes' }
  linux = @{ Name = 'hermes-cli-linux.tar.gz'; Sha256 = 'aead6eb0b8f563bb022354352eae32dad96c933330b6c1941b6db17674ca68ae'; Binary = 'hermes' }
}

$os = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'darwin' } else { 'linux' }
# Windows 11 on ARM64 runs x64 programs (emulated), so the Windows x64 build serves it too.
if ($os -eq 'linux' -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64')
{
  Stop-WithError "Hermes $version has $os binaries for x64 only, not $([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)."
}
$asset = $assets[$os]
$dir = Join-Path $repo node_modules/.cache/hermes
$binary = Join-Path $dir $asset.Binary
$stamp = Join-Path $dir version.txt

if ((Test-Path $binary) -and (Test-Path $stamp) -and (Get-Content -Raw $stamp).Trim() -eq "$version $($asset.Sha256)")
{
  Write-Host "Hermes $version is already installed: $binary"
}
else
{
  if (Test-Path $dir)
  {
    Remove-Item -Recurse -Force $dir
  }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $archive = Join-Path $dir $asset.Name
  $url = "https://github.com/facebook/hermes/releases/download/$version/$($asset.Name)"
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $archive -MaximumRetryCount 3 -RetryIntervalSec 5
  $hash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
  if ($hash -ne $asset.Sha256)
  {
    Stop-WithError "$($asset.Name) has SHA-256 $hash, not the pinned $($asset.Sha256)."
  }

  # .NET's tar reader (not a tar command: on Windows, which tar is first on the PATH varies), which keeps the Unix
  # file modes.
  $file = [IO.File]::OpenRead($archive)
  try {
    $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Decompress)
    [Formats.Tar.TarFile]::ExtractToDirectory($gzip, $dir, $true)
  } finally {
    $file.Dispose()
  }
  Remove-Item $archive
  if (-not $IsWindows)
  {
    chmod +x $binary
  }
  Set-Content -LiteralPath $stamp "$version $($asset.Sha256)"
  Write-Host "Installed Hermes $version`: $binary"
}

if ($env:GITHUB_ENV)
{
  Add-Content -LiteralPath $env:GITHUB_ENV "HERMES_PATH=$binary"
}
