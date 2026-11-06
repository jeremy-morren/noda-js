#requires -Version 7.4
<#
.SYNOPSIS
  Merges the CI test jobs' blob reports (scripts/test-blob.ps1) into one JUnit report and one coverage report.
.DESCRIPTION
  Two `vitest --merge-reports` runs, writing what `npm run test:ci` writes for a single run:
  1. Every blob in -Blobs (default test-results/blob): test-results/junit.xml (each suite named
     "<file> [<project>, <label>]", see test/vitest/junit-reporter.ts). Fails if any merged test failed.
  2. The node project's blobs only (node-*.json, the only ones with coverage): coverage/coverage-summary.json and
     coverage-final.json (the node project's coverage from every OS, moved onto this checkout's paths; see
     test/vitest/v8-node-only-coverage.ts). Separately, because loading the coverage provider at the end of the full
     merge (over a million tests) failed in CI, while a merge of the node blobs alone is quick and reliable.
  Every extra browser project is defined (NODA_TEST_BROWSERS), so that each blob's files find their project; none is
  started. A merged run holds every blob in memory, so Node gets a larger heap.
  Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/merge-test-reports.ps1
#>
param(
  [string] $Blobs = 'test-results/blob',
  [int] $MaxOldSpaceMB = 12288
)
. (Join-Path $PSScriptRoot ci-helpers.ps1)

$env:NODA_TEST_BROWSERS = 'edge,safari,ios-safari,android-chrome'
$env:NODE_OPTIONS = "$env:NODE_OPTIONS --max-old-space-size=$MaxOldSpaceMB".Trim()

Push-Location $repo
try {
  $files = @(Get-ChildItem $Blobs -File -Filter *.json)
  Write-Host "Merging $($files.Count) blob reports: $($files.Name -join ', ')"
  npx vitest --merge-reports=$Blobs `
    --reporter=default --reporter=./test/vitest/junit-reporter.ts --outputFile.junit=test-results/junit.xml
  $testsFailed = $LASTEXITCODE -ne 0

  # Coverage, from the node project's blobs.
  $nodeBlobs = Join-Path ([IO.Path]::GetTempPath()) "noda-js-node-blobs-$PID"
  New-Item -ItemType Directory -Force $nodeBlobs | Out-Null
  try {
    $nodeFiles = @(Get-ChildItem $Blobs -File -Filter 'node-*.json')
    if ($nodeFiles.Count -eq 0) {
      Stop-WithError "No node project blob reports (node-*.json) in ${Blobs}: no coverage to merge."
    }
    $nodeFiles | Copy-Item -Destination $nodeBlobs
    Write-Host "Merging the coverage of $($nodeFiles.Count) node blob reports: $($nodeFiles.Name -join ', ')"
    # The default reporter: a line per test file. (The dot reporter writes one line of ~265,000 characters, and the
    # step ended part way through it in CI, with no error.)
    npx vitest --merge-reports=$nodeBlobs --coverage --reporter=default
    if ($LASTEXITCODE -ne 0 -and -not $testsFailed) {
      Stop-WithError 'Merging the coverage failed.'
    }
  } finally {
    Remove-Item -Recurse -Force $nodeBlobs -ErrorAction Ignore
  }
  if ($testsFailed) {
    Stop-WithError 'Some merged tests failed.'
  }
} finally {
  Pop-Location
}
