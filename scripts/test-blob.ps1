#requires -Version 7.4
<#
.SYNOPSIS
  Runs Vitest projects and writes a blob report, for the CI test jobs; merge-test-reports.ps1 merges the blobs.
.DESCRIPTION
  Runs the given projects (vitest.config.ts: node, chromium, firefox, webkit, or one of the extra browsers edge,
  safari, ios-safari, android-chrome, which this defines through NODA_TEST_BROWSERS) and writes
  test-results/blob/<project>-<label>.json. The label says where the run happened: the OS (linux, windows, macos)
  unless -Label (or NODA_TEST_LABEL) names a device. It goes in the blob (VITEST_BLOB_LABEL), so the merged JUnit
  report names each suite "<file> [<project>, <label>]" (test/vitest/junit-reporter.ts).
  -Coverage adds v8 coverage, which only the node project collects (test/vitest/v8-node-only-coverage.ts); the blob
  carries it to the merge.
  Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/test-blob.ps1 -Project node -Coverage
#>
param(
  [Parameter(Mandatory)] [string[]] $Project,
  [string] $Label = $env:NODA_TEST_LABEL,
  [switch] $Coverage
)
. (Join-Path $PSScriptRoot ci-helpers.ps1)

if (-not $Label)
{
  $Label = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'macos' } else { 'linux' }
  # Windows on ARM64 (windows-11-arm) runs the node project too: label it apart from x64.
  if ($IsWindows -and [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64')
  {
    $Label = 'windows-arm64'
  }
}
$extra = @($Project | Where-Object { $_ -in 'edge', 'safari', 'ios-safari', 'android-chrome' })
if ($extra)
{
  $env:NODA_TEST_BROWSERS = $extra -join ','
}
$env:VITEST_BLOB_LABEL = $Label

$name = (($Project -join '+') + '-' + $Label) -replace '[^A-Za-z0-9.+-]+', '-'
$blob = "test-results/blob/$name.json"
$arguments = @('vitest', 'run') + ($Project | ForEach-Object { '--project', $_ }) +
  @('--reporter=default', '--reporter=blob', "--outputFile.blob=$blob")
if ($Coverage)
{
  $arguments += '--coverage'
}

Write-Host "Testing $($Project -join ', ') [$Label] -> $blob"
Push-Location $repo
try {
  npx @arguments
} finally {
  Pop-Location
}
