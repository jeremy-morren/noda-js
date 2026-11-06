#requires -Version 7.4
<#
.SYNOPSIS
  Shared by the release scripts (dot-sourced): strict error handling, and GitHub Actions outputs and error
  annotations that also work when a script runs locally.
#>
$ErrorActionPreference = 'Stop'
# A native command (git, gh, npm) that exits non-zero throws.
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
# The Windows native addon packages (scripts/build-native.ps1): optional dependencies of noda-js in releases.
$NativePackages = 'noda-js-win32-x64', 'noda-js-win32-arm64'

# Sets a step output (steps.<id>.outputs.<name>) when running in GitHub Actions; prints it either way.
function Set-ActionOutput([string] $Name, [string] $Value) {
  Write-Host "$Name=$Value"
  if ($env:GITHUB_OUTPUT)
  {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT "$Name=$Value"
  }
}

# Fails the script, with an error annotation on the run when in GitHub Actions.
function Stop-WithError([string] $Message) {
  if ($env:GITHUB_ACTIONS)
  {
    Write-Host "::error::$Message"
  }
  throw $Message
}

# The root package.json's version: the major.minor that releases are made in (maintained by hand, e.g. "0.2").
function Get-MajorMinor {
  $version = (Get-Content -Raw (Join-Path $repo package.json) | ConvertFrom-Json).version
  if ($version -cnotmatch '^[0-9]+\.[0-9]+$')
  {
    Stop-WithError "The root package.json's version must be MAJOR.MINOR (e.g. 0.2), not '$version'."
  }
  return $version
}

# The GitHub releases (tag and whether a draft), newest first.
function Get-Releases {
  return @((gh release list --limit 1000 --json tagName,isDraft) -join "`n" | ConvertFrom-Json)
}

# Runs tools/NodaJs.Package (archives: zip, tar-gzip, extract-tar-gzip), building it first, once per script. Built
# and run from tools/, so dotnet uses the SDK that tools/global.json pins.
$script:nodaJsPackageBuilt = $false
function Invoke-NodaJsPackage {
  $tools = Join-Path $repo tools
  Push-Location $tools
  try {
    if (-not $script:nodaJsPackageBuilt)
    {
      dotnet build NodaJs.Package -c Release -v q -nologo -clp:"ErrorsOnly;NoSummary"
      $script:nodaJsPackageBuilt = $true
    }
    dotnet (Join-Path $tools NodaJs.Package/bin/Release/net10.0/NodaJs.Package.dll) @args
  } finally {
    Pop-Location
  }
}
