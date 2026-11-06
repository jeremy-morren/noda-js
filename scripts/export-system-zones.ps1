#!/usr/bin/env pwsh
# Exports what NodaTime's BclDateTimeZoneSource (DateTimeZoneProviders.Bcl) sees on this machine, to
# test-results/system-zones.json: every zone's ID, names, adjustment rules and zone intervals (1800-2100), the IDs in
# order, the system default, the local zone, and .NET's IANA → Windows ID conversions. test/system/WindowsComparison.test.ts
# compares noda-js/system with it exactly (and skips itself without it). It's only meaningful on Windows, where
# TimeZoneInfo reads the registry, as noda-js/system does.
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/export-system-zones.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/export-system-zones.ps1 -Output some/other.json
#
# Steps: publish tools/NodaJs.Tools to tools/publish (as tools/generate.ps1 does), then run its system-zones command.
[CmdletBinding()]
param(
    # Where to write the JSON (default: test-results/system-zones.json).
    [string] $Output
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root 'tools'
$publish = Join-Path $tools 'publish'
if (-not $Output) { $Output = Join-Path $root 'test-results/system-zones.json' }

if (-not $IsWindows) {
    Write-Warning 'Not on Windows: TimeZoneInfo reads IANA zones here, which noda-js/system (Windows data or Intl) does not compare with.'
}

# From tools/, so dotnet uses the SDK that tools/global.json pins.
Push-Location $tools
try {
    dotnet publish NodaJs.Tools -c Release -o $publish -nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw 'Publish of NodaJs.Tools failed' }

    dotnet (Join-Path $publish 'NodaJs.Tools.dll') system-zones --repo $root --output $Output
    if ($LASTEXITCODE -ne 0) { throw 'NodaJs.Tools system-zones failed' }
} finally {
    Pop-Location
}
