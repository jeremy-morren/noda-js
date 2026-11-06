#requires -Version 7.4
<#
.SYNOPSIS
  Builds the Windows native addon (native/windows) into its optional package, src/noda-js-win32-<arch>
  (npm run build:native).
.DESCRIPTION
  Runs node-gyp for the given architecture (default: this machine's) with the C toolchain of the installed Visual
  Studio (the "Desktop development with C++" workload; ARM64 builds need its ARM64 build tools), and copies the result
  to src/noda-js-win32-<arch>/time-zones.node. The build is reproducible (see native/windows/binding.gyp).
  When the addon can run here (same architecture) and noda-js is built (npm run build), it then checks the addon
  against noda-js's node:ffi implementation (native/windows/compare.ts): every operation, for every time zone in the
  registry, must return the same values. Windows only.
#>
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string] $Arch = $(if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' })
)
. (Join-Path $PSScriptRoot ci-helpers.ps1)

if (-not $IsWindows) {
    Stop-WithError 'The native addon builds on Windows only.'
}
$native = Join-Path $repo native/windows
$package = Join-Path $repo "src/noda-js-win32-$Arch"

Push-Location $native
try {
    npx --no-install node-gyp rebuild "--arch=$Arch"
    if ($LASTEXITCODE -ne 0) { Stop-WithError "node-gyp failed for $Arch" }
} finally {
    Pop-Location
}
$addon = Join-Path $package time-zones.node
Copy-Item (Join-Path $native build/Release/time-zones.node) $addon -Force
Write-Output "Built $addon ($((Get-FileHash $addon -Algorithm SHA256).Hash))"

$hostArch = (node -p 'process.arch')
$ffiBuild = Join-Path $repo src/noda-js/dist/System/Windows/FfiWindowsTimeZoneApi.js
if ($hostArch -eq $Arch -and (Test-Path $ffiBuild)) {
    node (Join-Path $native compare.ts) $addon
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'The addon differs from the node:ffi implementation' }
} else {
    Write-Output 'Skipped the comparison with node:ffi (another architecture, or noda-js not built).'
}
